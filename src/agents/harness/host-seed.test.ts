import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { compactEmbeddedAgentSessionDirect as compactSession } from "../embedded-agent-runner/compact.js";
import { readCompactionAccountingRecorder } from "../embedded-agent-runner/run/compaction-accounting-bridge.js";
import {
  estimateCompactionHistoryTokens,
  resolveCompactionRetentionBudget,
} from "../sessions/compaction/request-budget.js";
import { withSessionCompactionPersistenceAsync as persistCompaction } from "../sessions/session-compaction-persistence.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { prepareHarnessContextMedia } from "./context-media-runtime.js";
import type { AgentHarnessContextMediaRequest } from "./host-capability-types.js";
import { bindBoundedSeed } from "./host-seed.js";

// mock-isolation: Keep real transcript and atomic persistence, replacing only summary model execution.
vi.mock("../embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: vi.fn(),
}));

async function seedFixture(
  state: OpenClawTestState,
  sessionId: string,
  entry: Parameters<typeof upsertSessionEntryCore>[1] = {},
) {
  setRuntimeConfigSnapshot({});
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: state.statePath("sessions.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1, ...entry });
  return {
    target,
    open: () => SessionManager.openAsync(target, state.workspaceDir),
    recorder: (text: string, timestamp: number, idempotencyKey: string) =>
      createUserTurnTranscriptRecorder({
        message: { ...makeUserMessage(text, timestamp), idempotencyKey },
        target: { ...target, sessionEntry: loadSessionEntry(target), cwd: state.workspaceDir },
      }),
    bind: (
      input: Parameters<typeof bindBoundedSeed>[0],
      signal?: AbortSignal,
      media?: Parameters<typeof bindBoundedSeed>[4],
    ) =>
      bindBoundedSeed(
        { sessionTarget: target, workspaceDir: state.workspaceDir, ...input },
        () => {},
        async (run) => run(),
        signal,
        media,
      ),
  };
}

const assistant = (text: string) =>
  makeAssistantMessageFixture({ content: [{ type: "text", text }] });
const appendUser = async (manager: SessionManager, text: string, timestamp: number) =>
  expectDefined(await manager.appendMessageAsync(makeUserMessage(text, timestamp)), "seed turn");

const allowance = {
  oldBytes: 1000,
  maxBytes: 8192,
  contextTokens: 128,
  requestTokens: 128,
  expectedBytes: 512,
};
type SeedCase = Partial<typeof allowance> & {
  name: string;
  summary?: string;
  expected?: number;
  revoke?: boolean;
  replaceWriter?: boolean;
  decline?: boolean;
  oversizedSummary?: boolean;
  oversizedTail?: boolean;
};

const generatedSummary = "covered old discussion; recent request";
it.each<SeedCase>([
  { name: "small history", oldBytes: 20, expected: 0 },
  { name: "unsummarized history", oversizedTail: true },
  { name: "declined summary", summary: "existing", decline: true, oversizedTail: true },
  { ...allowance, name: "narrow delivery allowance", contextTokens: 1024 },
  { ...allowance, name: "larger allowance cannot widen host", requestTokens: 1024 },
  { ...allowance, name: "invalid allowance is ignored", requestTokens: Infinity },
  { ...allowance, name: "oversized summary is bounded again", oversizedSummary: true },
  { name: "omitted existing summary", summary: "summary ".repeat(1024), expected: 0 },
  { name: "unsummarized retained tail", summary: "older prefix covered" },
  { name: "revoked source", revoke: true },
  { name: "replaced writer", replaceWriter: true },
])(
  "prepares a bounded seed for $name",
  ({
    name,
    oldBytes = 4096,
    summary,
    expected = 1,
    revoke,
    replaceWriter,
    decline,
    maxBytes = 1024,
    contextTokens,
    requestTokens,
    expectedBytes = maxBytes,
    oversizedSummary,
    oversizedTail,
  }) =>
    withOpenClawTestState({ label: "native-seed" }, async (state) => {
      const fixture = await seedFixture(state, "seed", {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        activeWriterRunId: "seed-writer",
        transcriptByteCompactionLatch: { activeBytes: 4096, maxBytes: 1024, sessionId: "seed" },
      });
      const { target } = fixture;
      let manager = await fixture.open();
      const old = await appendUser(manager, "old".repeat(oldBytes), 1);
      const recent = await appendUser(manager, "recent request", 2);
      if (oversizedTail) {
        await manager.appendMessageAsync(assistant(`TAIL_EVIDENCE ${"tail".repeat(50_000)}`));
      }
      if (summary) {
        await manager.appendCompactionAsync(
          summary,
          name === "unsummarized retained tail" ? old : recent,
          2048,
        );
      }
      const recorder = fixture.recorder("pending", 3, "seed:pending");
      await recorder.persistApproved();
      manager = await fixture.open();
      const originalEvents = loadTranscriptEventsSync(target);
      const assertCurrent = vi.fn();
      const compact = vi.mocked(compactSession).mockReset();
      compact.mockImplementationOnce(async (params, persist) => {
        if (decline) {
          return { ok: false, compacted: false, reason: "fixture declines compaction" };
        }
        if (revoke) {
          assertCurrent.mockImplementation(() => {
            throw new Error("native binding revoked");
          });
        }
        if (replaceWriter) {
          await upsertSessionEntryCore(target, { activeWriterRunId: "replacement-writer" });
        }
        const constraints = readCompactionAccountingRecorder(params.contextEngineRuntimeContext);
        const budget = constraints?.requestBudget;
        const result = prepareCompaction(
          manager.getBranch(),
          DEFAULT_COMPACTION_SETTINGS,
          "unresolved",
          {
            preserveFromEntryId: constraints?.pendingUserEntryId,
            budget: budget
              ? {
                  ...resolveCompactionRetentionBudget(budget, []),
                  estimateTokens: (message: AgentMessage) =>
                    estimateCompactionHistoryTokens([message], budget),
                }
              : undefined,
          },
        );
        const prepared = expectDefined(result.ok ? result.value : undefined, "prepared compaction");
        expect(
          JSON.stringify([...prepared.messagesToSummarize, ...prepared.turnPrefixMessages]),
        ).toContain(oversizedTail ? "TAIL_EVIDENCE" : "recent request");
        await persistCompaction(manager, persist, () =>
          manager.appendCompactionAsync(
            oversizedSummary ? "generated".repeat(1000) : generatedSummary,
            prepared.firstKeptEntryId,
            2048,
          ),
        );
        return { ok: true, compacted: true };
      });
      const maybePrepare = fixture.bind({
        sessionTarget: { ...target, expectedWriterRunId: "seed-writer" },
        contextTokenBudget: contextTokens,
        config: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: maxBytes } } } },
        userTurnTranscriptRecorder: recorder,
      })?.prepareBoundedSeed;
      const prepare = expectDefined(maybePrepare, "missing seed capability");
      const result = prepare({ assertCurrent, tokenBudget: requestTokens });
      if (revoke || replaceWriter) {
        await expect(result).rejects.toThrow(
          revoke ? "native binding revoked" : /writer|claim|changed/i,
        );
        expect(loadTranscriptEventsSync(target)).toEqual(originalEvents);
      } else {
        const seed = await result;
        expect(Buffer.byteLength(JSON.stringify(seed))).toBeLessThanOrEqual(expectedBytes);
        if (!expected && !oversizedTail) {
          expect(seed).toContainEqual(makeUserMessage("recent request", 2));
        }
        if (expected && !decline) {
          expect(seed.filter((message) => message.role === "compactionSummary")).toEqual(
            oversizedSummary
              ? []
              : expect.arrayContaining([expect.objectContaining({ summary: generatedSummary })]),
          );
          expect(loadSessionEntry(target)?.compactionCount).toBe(1);
          expect(loadSessionEntry(target)?.transcriptByteCompactionLatch).toBeUndefined();
        }
        if (decline) {
          expect(loadTranscriptEventsSync(target)).toEqual(originalEvents);
          expect(JSON.stringify(seed)).toContain("Older history outside that window is omitted");
          expect(seed).toContainEqual(
            expect.objectContaining({ role: "compactionSummary", summary }),
          );
        }
        expect(loadTranscriptEventsSync(target)).toEqual(expect.arrayContaining(originalEvents));
      }
      expect(compact).toHaveBeenCalledTimes(expected);
    }),
);

it.each([false, true])("preserves the admitted task only for a refresh seed (%s)", (refresh) =>
  withOpenClawTestState({ label: "native-refresh-seed" }, async (state) => {
    const fixture = await seedFixture(state, "refresh");
    const manager = await fixture.open();
    await manager.appendMessageAsync(makeUserMessage("Earlier history".repeat(600), 1));
    const recorder = fixture.recorder("ORIGINAL_ADMITTED_TASK", 2, "refresh:user");
    const persisted = expectDefined(await recorder.persistApproved(), "persisted original task");
    const stale = assistant("stale persisted tail");
    const current = assistant("authoritative refresh handoff".repeat(600));
    const afterAdmission = await fixture.open();
    await afterAdmission.appendMessageAsync(stale);
    const maybePrepare = fixture.bind({
      config: {
        agents: {
          defaults: { compaction: { enabled: false, maxActiveTranscriptBytes: 8192 } },
        },
      },
      userTurnTranscriptRecorder: recorder,
      ...(refresh ? { pluginRuntimeRefreshMessages: [persisted.message, current] } : {}),
    })?.prepareBoundedSeed;
    const prepare = expectDefined(maybePrepare, "fixture has no seed capability");
    const seed = await prepare({ assertCurrent: () => {} });
    expect(JSON.stringify(seed)).toContain("Older history outside that window is omitted");
    expect(
      seed.filter(
        (message) => message.role === "user" && message.content === "ORIGINAL_ADMITTED_TASK",
      ),
    ).toHaveLength(refresh ? 1 : 0);
    if (refresh) {
      expect(seed).toContainEqual(current);
      expect(seed).not.toContainEqual(stale);
      await expect(prepare({ assertCurrent: () => {}, tokenBudget: 1024 })).rejects.toThrow(
        "Active native continuation exceeds the history delivery allowance",
      );
    }
  }),
);

it.each([1, 2])("bounds restored images and reuses their prepared snapshot (%s)", (imageCount) =>
  withOpenClawTestState({ label: "native-media-seed" }, async (state) => {
    const fixture = await seedFixture(state, "media");
    const paths = Array.from({ length: imageCount }, (_, index) =>
      path.join(state.workspaceDir, `image-${index}.png`),
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    );
    await Promise.all(paths.map((file) => writeFile(file, png)));
    const manager = await fixture.open();
    const imageTurn: PersistedUserTurnMessage = {
      ...makeUserMessage("Stored image question", 1),
      __openclaw: {
        media: paths.map((file) => ({ path: file, contentType: "image/png", kind: "image" })),
      },
    };
    await manager.appendMessageAsync(imageTurn);
    const recent = await appendUser(manager, "Recent text", 2);
    const compact = vi.mocked(compactSession).mockReset();
    compact.mockImplementationOnce(async (_params, persist) => {
      await persistCompaction(manager, persist, () =>
        manager.appendCompactionAsync("Image question summarized", recent, 4000),
      );
      return { ok: true, compacted: true };
    });
    const restore = vi.fn((request: AgentHarnessContextMediaRequest) =>
      prepareHarnessContextMedia({
        ...request,
        workspaceDir: state.workspaceDir,
        modelInput: ["text", "image"],
        assertCurrent: () => {},
      }),
    );
    const media = { capabilities: { prepareContextMedia: restore } };
    const source = new AbortController();
    const bound = fixture.bind(
      {
        contextTokenBudget: 8192,
        config: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "20mb" } } } },
      },
      source.signal,
      media,
    );
    const prepare = expectDefined(bound?.prepareBoundedSeed, "media seed capability");
    const seed = await prepare({
      assertCurrent: () => {},
      tokenBudget: imageCount === 1 ? 4096 : 2048,
    });
    const imageMessage = seed.find(
      (message) => message.role === "user" && message.content === "Stored image question",
    );
    if (imageCount === 2) {
      expect(imageMessage).toBeUndefined();
      expect(compact).toHaveBeenCalledOnce();
    } else {
      const fittingImage = expectDefined(imageMessage, "Fitting image turn was omitted");
      const calls = restore.mock.calls.length;
      await Promise.all(paths.map((file) => unlink(file)));
      const restoreFromSeed = bound?.prepareContextMedia ?? media.capabilities.prepareContextMedia;
      const prepared = await restoreFromSeed({ message: fittingImage, maxChars: 8192 });
      expect(prepared.images).toHaveLength(1);
      expect(restore).toHaveBeenCalledTimes(calls);
      expect(compact).not.toHaveBeenCalled();
      source.abort(new Error("seed source closed"));
      await expect(restoreFromSeed({ message: fittingImage, maxChars: 8192 })).rejects.toThrow(
        "seed source closed",
      );
      await expect(prepare({ assertCurrent: () => {} })).rejects.toThrow("seed source closed");
      expect(restore).toHaveBeenCalledTimes(calls);
    }
  }),
);
