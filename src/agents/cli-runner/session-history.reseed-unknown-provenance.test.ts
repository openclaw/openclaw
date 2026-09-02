/**
 * Whether a CLI binding cleared with *unknown* auth provenance may replay its
 * prior transcript into the next fresh CLI session.
 *
 * The sibling `session-history.reseed-auth-boundary.test.ts` covers the clears
 * that can name an identity — from the outgoing binding, or from the clearing
 * turn's own resolved auth. This file covers the clears that cannot name one at
 * all: a handled `before_agent_reply` synthetic turn returns
 * `clearCliSessionBinding` before `prepareCliRunContext` resolves any auth, so
 * its `agentMeta` carries no `cliSessionAuthIdentity` (pinned at the producer in
 * `cli-runner.before-agent-reply-cron.test.ts`). Combined with a stored binding
 * that recorded no identity either — a legacy `cliSessionIds` /
 * `claudeCliSessionId` row, or a modern binding written by the bare-id fallback
 * — nothing in the system knows which identity wrote the transcript.
 *
 * The whole path runs for real: the clear goes through `persistSessionUsageUpdate`
 * into the session store, the transcript lives in the SQLite transcript store,
 * and the next turn's decision is re-read from the store rather than carried in
 * memory. Asserting on the constructed prompt rather than on the reason code is
 * deliberate — the reason is a means, the prompt is what reaches the model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistSessionUsageUpdate } from "../../auto-reply/reply/session-usage.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { CliSessionBinding, SessionEntry } from "../../config/sessions/types.js";
import { CLI_AUTH_EPOCH_VERSION } from "../cli-auth-epoch.js";
import { getCliSessionBinding, resolveCliSessionReuse } from "../cli-session.js";
import { SessionManager } from "../sessions/session-manager.js";
import { buildCliSessionHistoryPrompt, loadCliSessionReseedMessages } from "./session-history.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";
const SESSION_ID = "session-unknown-provenance-clear";
const PROVIDER = "claude-cli";

const RAW_SECRET = "prior-auth raw secret";
const SUMMARY_SECRET = "Summary derived from the prior-auth conversation";
const TAIL_SECRET = "post-compaction tail secret";

/** The identity the stored transcript was actually written under. */
const PRIOR_IDENTITY = {
  authProfileId: "anthropic:prior",
  authEpoch: "epoch-prior",
  authEpochVersion: CLI_AUTH_EPOCH_VERSION,
} as const;
/** Same install, different auth profile: the crossing reported as `auth-profile`. */
const ROTATED_PROFILE = {
  authProfileId: "anthropic:rotated",
  authEpoch: "epoch-rotated",
  authEpochVersion: CLI_AUTH_EPOCH_VERSION,
} as const;
/** Same profile, rotated credential under the same version: reported as `auth-epoch`. */
const ROTATED_EPOCH = {
  authProfileId: PRIOR_IDENTITY.authProfileId,
  authEpoch: "epoch-rotated",
  authEpochVersion: CLI_AUTH_EPOCH_VERSION,
} as const;

type AuthIdentity = {
  authProfileId?: string;
  authEpoch?: string;
  authEpochVersion: number;
};

const caseDirs: string[] = [];

afterEach(() => {
  for (const dir of caseDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStorePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-unknown-provenance-"));
  caseDirs.push(root);
  return path.join(root, "agents", AGENT_ID, "sessions", "sessions.json");
}

/**
 * Writes the prior conversation into the SQLite transcript store.
 *
 * No JSONL file is written: the canonical store is the only transcript source
 * `loadCliSessionEntries` reads — the exact configuration the reported
 * regression lives on.
 */
async function seedTranscript(storePath: string, shape: "raw" | "compacted"): Promise<void> {
  const target = {
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    storePath,
  };
  await upsertSessionEntryCore(target, { sessionId: SESSION_ID, updatedAt: 1 });
  // Written through SessionManager so the compaction boundary carries the
  // retained-cut metadata the canonical reader rebuilds context from; a
  // hand-rolled compaction event has no first-kept entry to anchor to.
  const manager = SessionManager.open(target, path.dirname(storePath));
  const kept = manager.appendMessage({ role: "user", content: RAW_SECRET, timestamp: 1 });
  if (shape === "compacted") {
    manager.appendCompaction(SUMMARY_SECRET, kept, 1000);
    manager.appendMessage({ role: "user", content: TAIL_SECRET, timestamp: 3 });
  }
  manager.flushPendingPersistence();
}

/** Record shapes a stored CLI session can have when the clear arrives. */
type StoredBindingShape =
  /** Pre-bindings rows: `cliSessionIds` plus the shipped Claude-only mirror. */
  | "legacy-rows"
  /** A modern binding from the bare-id fallback: a session id and nothing else. */
  | "bare-binding"
  /** A binding that DID record its identity — the control for #124991 narrowness. */
  | "identified-binding";

async function seedSessionEntry(storePath: string, shape: StoredBindingShape): Promise<void> {
  const binding: CliSessionBinding | undefined =
    shape === "bare-binding"
      ? { sessionId: "native-prior" }
      : shape === "identified-binding"
        ? { sessionId: "native-prior", ...PRIOR_IDENTITY }
        : undefined;
  await replaceSessionEntry({ storePath, sessionKey: SESSION_KEY }, {
    sessionId: SESSION_ID,
    updatedAt: 1,
    modelProvider: PROVIDER,
    model: "claude-sonnet-4-6",
    ...(binding
      ? { cliSessionBindings: { [PROVIDER]: binding } }
      : { cliSessionIds: { [PROVIDER]: "native-prior" }, claudeCliSessionId: "native-prior" }),
  } as SessionEntry);
}

/**
 * Replays the persistence a handled synthetic turn performs.
 *
 * These are exactly the fields `accountAgentTurn` derives from that turn's
 * `agentMeta`: `clearCliSessionBinding` is true, `cliSessionAuthIdentity` is
 * absent because no auth was ever resolved, and there is no usage — so the
 * write lands in `persistSessionUsageUpdate`'s model/context branch, which is
 * the branch a zero-token synthetic reply actually takes.
 */
async function clearThroughSyntheticTurn(storePath: string): Promise<void> {
  await persistSessionUsageUpdate({
    storePath,
    sessionKey: SESSION_KEY,
    providerUsed: PROVIDER,
    modelUsed: "claude-sonnet-4-6",
    contextTokensUsed: 200_000,
    clearCliSessionBinding: true,
    cliSessionAuthIdentity: undefined,
  });
}

function readStoredEntry(storePath: string): SessionEntry {
  const entry = loadSessionEntry({ storePath, sessionKey: SESSION_KEY, readConsistency: "latest" });
  if (!entry) {
    throw new Error("expected the cleared session entry to still exist in the store");
  }
  return entry as SessionEntry;
}

/**
 * The next turn, decided from the re-read store entry.
 *
 * Mirrors `prepare.ts`: reuse resolution first, then its reason default, then
 * the loader, then the prompt the CLI process would actually receive.
 */
async function historyPromptForNextTurn(params: {
  storePath: string;
  current: AuthIdentity;
}): Promise<{ reason: string; messages: unknown[]; prompt: string }> {
  const entry = readStoredEntry(params.storePath);
  const reuse = resolveCliSessionReuse({
    binding: getCliSessionBinding(entry, PROVIDER),
    ...params.current,
  });
  expect(reuse.mode).not.toBe("reuse");
  expect(reuse.mode).not.toBe("reuse-with-drift");
  const invalidatedReason = reuse.mode === "invalidate" ? reuse.invalidatedReason : undefined;
  const reason = invalidatedReason ?? "missing-transcript";
  const messages = await loadCliSessionReseedMessages({
    sessionTarget: {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      storePath: params.storePath,
    },
    // The claude-cli backend opts in (`reseedFromRawTranscriptWhenUncompacted`).
    allowRawTranscriptReseed: true,
    rawTranscriptReseedReason: reason,
  });
  return {
    reason,
    messages,
    // Absent when nothing survived the refusal; flattened so every assertion
    // below reads the same way whether the refusal happened at the loader or
    // at prompt construction.
    prompt: buildCliSessionHistoryPrompt({ messages, prompt: "next turn" }) ?? "",
  };
}

async function runUnknownProvenanceClear(params: {
  transcript: "raw" | "compacted";
  stored: StoredBindingShape;
  current: AuthIdentity;
}): Promise<{
  reason: string;
  messages: unknown[];
  prompt: string;
  binding: CliSessionBinding | undefined;
}> {
  const storePath = createStorePath();
  await seedTranscript(storePath, params.transcript);
  await seedSessionEntry(storePath, params.stored);
  await clearThroughSyntheticTurn(storePath);
  const result = await historyPromptForNextTurn({ storePath, current: params.current });
  return { ...result, binding: getCliSessionBinding(readStoredEntry(storePath), PROVIDER) };
}

describe.each([
  { stored: "legacy-rows" as const, label: "legacy cliSessionIds rows" },
  { stored: "bare-binding" as const, label: "a bare-id fallback binding" },
])(
  "unknown-provenance clear of $label, persisted and re-read",
  ({ stored }: { stored: StoredBindingShape }) => {
    it("persists a tombstone that is distinguishable from an identity boundary", async () => {
      const storePath = createStorePath();
      await seedTranscript(storePath, "raw");
      await seedSessionEntry(storePath, stored);
      await clearThroughSyntheticTurn(storePath);

      // Erasing the record is the defect: the next turn would read the session
      // as never-bound. The tombstone must survive the store round-trip, carry
      // no resumable handle, and carry no identity fields that a later turn
      // could accidentally match against.
      const binding = getCliSessionBinding(readStoredEntry(storePath), PROVIDER);
      expect(binding).toStrictEqual({ clearedAuthProvenance: "unknown" });
    });

    it.each([
      { name: "auth profile", current: ROTATED_PROFILE },
      { name: "auth epoch", current: ROTATED_EPOCH },
      // Included because the transcript is unattributable: an identity that
      // happens to equal the prior one still cannot be *shown* to, so the same
      // refusal applies. This is the bounded cost the fix accepts.
      { name: "identity that merely looks unchanged", current: PRIOR_IDENTITY },
    ])("gives the next turn no raw history under a changed $name", async ({ current }) => {
      const { reason, messages, prompt } = await runUnknownProvenanceClear({
        transcript: "raw",
        stored,
        current,
      });
      // Leak assertions first: a regression here should read as "the prior
      // transcript reached the prompt", not as "a reason string changed".
      expect(prompt).not.toContain(RAW_SECRET);
      expect(messages).toStrictEqual([]);
      expect(reason).toBe("auth-unknown");
    });

    it.each([
      { name: "auth profile", current: ROTATED_PROFILE },
      { name: "auth epoch", current: ROTATED_EPOCH },
    ])(
      "gives the next turn no compacted summary or tail under a changed $name",
      async ({ current }) => {
        // The compacted branch returns a summary plus the post-compaction tail
        // by a different route than the raw allowlist, so it needs its own
        // refusal or the same content leaks through it.
        const { reason, messages, prompt } = await runUnknownProvenanceClear({
          transcript: "compacted",
          stored,
          current,
        });
        expect(prompt).not.toContain(SUMMARY_SECRET);
        expect(prompt).not.toContain(TAIL_SECRET);
        expect(messages).toStrictEqual([]);
        expect(reason).toBe("auth-unknown");
      },
    );
  },
);

describe("unknown-provenance clear of a binding that DID record its identity", () => {
  // The narrowness control. #124991 is the bug where a cleared binding stopped
  // reseeding at all; the fix for it depends on a same-identity clear still
  // replaying. An unknown-provenance clear must not swallow that case: when the
  // outgoing binding carries an identity, that identity is still the boundary,
  // and only the identity comparison decides. Without these, the fix above
  // could be passing by refusing everything.
  it("still replays the prior transcript to the same identity", async () => {
    const { reason, prompt } = await runUnknownProvenanceClear({
      transcript: "raw",
      stored: "identified-binding",
      current: PRIOR_IDENTITY,
    });
    expect(reason).toBe("missing-transcript");
    expect(prompt).toContain(RAW_SECRET);
  });

  it("still replays the compacted summary and tail to the same identity", async () => {
    const { reason, prompt } = await runUnknownProvenanceClear({
      transcript: "compacted",
      stored: "identified-binding",
      current: PRIOR_IDENTITY,
    });
    expect(reason).toBe("missing-transcript");
    expect(prompt).toContain(SUMMARY_SECRET);
    expect(prompt).toContain(TAIL_SECRET);
  });

  it.each([
    { name: "auth-profile", current: ROTATED_PROFILE, expected: "auth-profile" },
    { name: "auth-epoch", current: ROTATED_EPOCH, expected: "auth-epoch" },
  ])("reports the crossing as $name rather than auth-unknown", async ({ current, expected }) => {
    const { reason, messages, prompt, binding } = await runUnknownProvenanceClear({
      transcript: "raw",
      stored: "identified-binding",
      current,
    });
    expect(prompt).not.toContain(RAW_SECRET);
    expect(messages).toStrictEqual([]);
    expect(binding).toStrictEqual(PRIOR_IDENTITY);
    expect(reason).toBe(expected);
  });
});
