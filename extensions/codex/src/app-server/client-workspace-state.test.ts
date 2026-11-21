import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareCodexWorkspaceReferenceState,
  readCodexWorkspaceModelContext,
  type CodexClientWorkspaceState,
} from "./client-workspace-state.js";
import type { CodexAppServerClient } from "./client.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const threadId = "native-thread";
// The bound rollout path means the reader never asks the app-server for one.
const client = {} as CodexAppServerClient;

const line = (type: string, payload: unknown) => `${JSON.stringify({ type, payload })}\n`;
const worldState = (full: boolean, state: Record<string, unknown>) =>
  line("world_state", { full, state });

function workspaceState(): CodexClientWorkspaceState {
  return {
    closed: false,
    sessionMetadata: new Map(),
    modelContextScans: new Map(),
    workspaceReferences: new Map(),
  };
}

describe("readCodexWorkspaceModelContext", () => {
  it("follows Codex's recorded base instructions and current AGENTS.md across appends", async () => {
    const sessionsRoot = tempDirs.make("codex-model-context-");
    const rolloutPath = path.join(sessionsRoot, "rollout.jsonl");
    await fs.writeFile(
      rolloutPath,
      line("session_meta", {
        id: threadId,
        base_instructions: { text: "Base policy.", provenance: { type: "custom" } },
      }) +
        // A nested "world_state" string inside a message must not count as a record.
        line("response_item", { type: "message", content: [{ text: '"type":"world_state"' }] }) +
        worldState(true, { agents_md: { directory: "/workspace", text: "Use tabs." } }) +
        worldState(false, { agents_md: { text: "Use spaces." } }) +
        // Codex may still be writing the last record when the turn settles.
        '{"type":"world_state","payload":{"full":true,',
    );
    const state = workspaceState();
    const read = () =>
      readCodexWorkspaceModelContext(client, state, sessionsRoot, rolloutPath, threadId, 8);

    await expect(read()).resolves.toEqual({
      baseInstructions: "Base policy.",
      agentsMd: { directory: "/workspace", text: "Use spaces." },
    });

    await fs.appendFile(
      rolloutPath,
      '"state":{"agents_md":{"directory":"/workspace","text":"Rewritten."}}}}\n' +
        line("compacted", { message: "" }),
    );
    // A compaction drops the baseline until Codex records the next full world state.
    await expect(read()).resolves.toEqual({ baseInstructions: "Base policy." });

    await fs.appendFile(
      rolloutPath,
      worldState(true, { agents_md: { directory: null, text: null } }) +
        worldState(false, { agents_md: { directory: "/workspace", text: "Back again." } }),
    );
    await expect(read()).resolves.toEqual({
      baseInstructions: "Base policy.",
      agentsMd: { directory: "/workspace", text: "Back again." },
    });
  });

  it("drops AGENTS.md after a thread rollback and recovers from an abandoned scan", async () => {
    const sessionsRoot = tempDirs.make("codex-model-context-rollback-");
    const rolloutPath = path.join(sessionsRoot, "rollout.jsonl");
    const meta = line("session_meta", { id: threadId, base_instructions: { text: "Base." } });
    await fs.writeFile(
      rolloutPath,
      meta +
        worldState(true, { agents_md: { directory: "/workspace", text: "Old rules." } }) +
        worldState(false, { agents_md: { text: "Rolled-back rules." } }),
    );
    const state = workspaceState();
    const read = (signal?: AbortSignal) =>
      readCodexWorkspaceModelContext(client, state, sessionsRoot, rolloutPath, threadId, 8, signal);

    // An abandoned read reports nothing; the next read still sees the full history.
    await expect(read(AbortSignal.abort())).rejects.toThrow();
    await expect(read()).resolves.toMatchObject({ agentsMd: { text: "Rolled-back rules." } });

    // Codex replays without the dropped turn's patch; never report the discarded text.
    await fs.appendFile(
      rolloutPath,
      line("event_msg", { type: "thread_rolled_back", num_turns: 1 }),
    );
    await expect(read()).resolves.toEqual({ baseInstructions: "Base." });
  });
});

describe("native thread runtime-reference admission (#84662)", () => {
  it("sends unchanged workspace and watched-session references only once over three turns", () => {
    const state = workspaceState();
    const included: Array<[boolean, boolean]> = [];
    for (let turn = 0; turn < 3; turn++) {
      const refs = prepareCodexWorkspaceReferenceState(
        state,
        threadId,
        "workspace instructions",
        "## Watched Sessions\n- synthetic session",
      );
      included.push([refs.includeWorkspace, refs.includeWatchedSessions]);
      refs.accepted({
        workspaceAccepted: refs.includeWorkspace,
        watchedSessionsAccepted: refs.includeWatchedSessions,
      });
    }
    expect(included).toEqual([[true, true], [false, false], [false, false]]);
  });

  it("resends only a changed reference, and retries a truncated section", () => {
    const state = workspaceState();
    const first = prepareCodexWorkspaceReferenceState(
      state,
      threadId,
      "workspace A",
      "watched A",
    );
    first.accepted({ workspaceAccepted: true, watchedSessionsAccepted: true });

    const changed = prepareCodexWorkspaceReferenceState(
      state,
      threadId,
      "workspace A",
      "watched B",
    );
    expect([changed.includeWorkspace, changed.includeWatchedSessions]).toEqual([false, true]);
    changed.accepted({ workspaceAccepted: false, watchedSessionsAccepted: false });
    expect(
      prepareCodexWorkspaceReferenceState(state, threadId, "workspace A", "watched B")
        .includeWatchedSessions,
    ).toBe(true);

    const retried = prepareCodexWorkspaceReferenceState(
      state,
      threadId,
      "workspace A",
      "watched B",
    );
    retried.accepted({ workspaceAccepted: false, watchedSessionsAccepted: true });
    expect(
      prepareCodexWorkspaceReferenceState(state, threadId, "workspace A", "watched B")
        .includeWatchedSessions,
    ).toBe(false);
    expect(
      prepareCodexWorkspaceReferenceState(state, threadId, "workspace C", "watched B")
        .includeWorkspace,
    ).toBe(true);
  });

  it("does not acknowledge stale attempts when compaction re-arms the thread", () => {
    const state = workspaceState();
    const refs = prepareCodexWorkspaceReferenceState(state, threadId, "workspace", "watched");
    const original = state.workspaceReferences.get(threadId)!;
    state.workspaceReferences.set(threadId, {
      ...original,
      needsReintroduction: true,
      needsWatchedSessionsReintroduction: true,
    });
    refs.accepted({ workspaceAccepted: true, watchedSessionsAccepted: true });
    const next = prepareCodexWorkspaceReferenceState(state, threadId, "workspace", "watched");
    expect([next.includeWorkspace, next.includeWatchedSessions]).toEqual([true, true]);
  });

  it("does not emit empty references and reintroduces both on a cold thread", () => {
    const state = workspaceState();
    const empty = prepareCodexWorkspaceReferenceState(state, threadId, "  ", undefined);
    expect([empty.includeWorkspace, empty.includeWatchedSessions]).toEqual([false, false]);
    const refs = prepareCodexWorkspaceReferenceState(state, threadId, "workspace", "watched");
    refs.accepted({ workspaceAccepted: true, watchedSessionsAccepted: true });
    state.workspaceReferences.delete(threadId);
    const resumed = prepareCodexWorkspaceReferenceState(state, threadId, "workspace", "watched");
    expect([resumed.includeWorkspace, resumed.includeWatchedSessions]).toEqual([true, true]);
  });
});
