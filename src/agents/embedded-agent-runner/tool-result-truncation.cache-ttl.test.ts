import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentContextPruningConfig } from "../../config/types.agent-defaults.js";
import * as cryptoDigest from "../../infra/crypto-digest.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { serializeCacheTtlToolResultProjections as snapshot } from "./cache-ttl-checkpoint.js";
import { appendAttemptCacheTtlIfNeeded } from "./run/attempt-thread-helpers.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState as newState,
  retainEmbeddedSessionPromptState as retainState,
} from "./session-prompt-state.js";
import { replayToolResultPromptProjections } from "./tool-result-projection-replay.js";
import {
  projectToolResultMessages,
  pruneExpiredCacheTtlToolResults,
  reconcileToolResultPromptProjectionState as reconcile,
  resolveCacheTtlPruningSettings,
  restoreCacheTtlToolResultProjections as restore,
  truncateOversizedToolResultsInMessages as truncate,
} from "./tool-result-truncation.js";

afterEach(() =>
  clearEmbeddedSessionPromptStates(["ordinary-turn-teardown", "cache-ttl-soft", "cache-ttl-hard"]),
);
const NOW = 1_000_000;
const checkpoint = (data: unknown) => [{ type: "custom", customType: "openclaw.cache-ttl", data }];

function assistant(content: unknown = [{ type: "text", text: "assistant" }]): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    timestamp: 1,
  } as AgentMessage;
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function tool(params: { id: string; text?: unknown; image?: boolean }): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.id,
    toolName: "read",
    content: [
      ...(params.image ? [{ type: "image", data: "AA==", mimeType: "image/png" }] : []),
      { type: "text", text: params.text ?? "result" },
    ],
    details: { source: params.id },
    isError: params.id === "error",
    timestamp: 42,
  } as AgentMessage;
}

function prunableHistory(oldTools: AgentMessage[]): AgentMessage[] {
  return [
    user("first"),
    assistant(),
    ...oldTools,
    ...["second", "third", "fourth"].flatMap((text) => [user(text), assistant()]),
  ];
}

function addNewRound(history: AgentMessage[]): AgentMessage[] {
  return [
    ...history,
    assistant(),
    tool({ id: "new", text: "b".repeat(5_000) }),
    ...Array.from({ length: 3 }, () => assistant()),
  ];
}

function settings(config: AgentContextPruningConfig = { mode: "cache-ttl" }) {
  const resolved = resolveCacheTtlPruningSettings(config);
  if (!resolved) {
    throw new Error("expected cache-TTL settings");
  }
  return resolved;
}

type PruningOptions = Partial<
  Omit<Parameters<typeof pruneExpiredCacheTtlToolResults>[0], "messages" | "settings">
>;
function project(messages: AgentMessage[], options: PruningOptions = {}): AgentMessage[] {
  return pruneExpiredCacheTtlToolResults({
    messages,
    settings: settings(),
    contextWindowTokens: 1_000,
    lastCacheTouchAt: NOW - 300_000,
    dropThinkingBlocksForEstimate: false,
    now: NOW,
    projectionState: newState(),
    pruneNewRounds: true,
    ...options,
  });
}

function toolText(messages: AgentMessage[], id: string): string {
  const message = messages.find(
    (candidate) => candidate.role === "toolResult" && candidate.toolCallId === id,
  );
  if (!message || message.role !== "toolResult") {
    throw new Error(`missing tool result ${id}`);
  }
  return message.content
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

describe("cache-TTL tool-result projection", () => {
  it("hashes each frozen source once across interleaved sessions and recreated attempt state", () => {
    using digest = vi.spyOn(cryptoDigest, "sha256Base64Url");
    const sessions = ["first", "second"].map((text) => ({
      messages: [freezeJsonSnapshot(tool({ id: "shared-id", text }))],
      state: newState(),
    }));
    for (const session of sessions) {
      projectToolResultMessages({ messages: session.messages, projectionState: session.state });
    }
    expect(digest).toHaveBeenCalledTimes(2);
    const hashes = sessions.flatMap(({ state }) => [...state.sourceHashByKey.values()]);
    expect(new Set(hashes).size).toBe(2);
    for (let turn = 0; turn < 3; turn++) {
      for (const session of sessions) {
        reconcile(session.messages, session.state);
        const recreated = newState();
        expect(
          projectToolResultMessages({ messages: session.messages, projectionState: recreated })
            .messages,
        ).toEqual(session.messages);
        expect(recreated.sourceHashByKey).toEqual(session.state.sourceHashByKey);
      }
    }
    expect(digest).toHaveBeenCalledTimes(2);
  });

  it.each(["mutable", "shallow", "deep"])(
    "invalidates rewritten %s sources without losing another session's projection",
    (mode) => {
      const block = { type: "text" as const, text: "original".repeat(1_000) };
      let source = { ...tool({ id: "same" }), content: [block] };
      if (mode === "shallow") {
        Object.freeze(source.content);
        Object.freeze(source);
      } else if (mode === "deep") {
        freezeJsonSnapshot(source);
      }
      const state = newState();
      const other = newState();
      const otherMessages = [freezeJsonSnapshot(tool({ id: "same", text: "other".repeat(1_000) }))];
      const sent = truncate([source], 128_000, 500, 1_000, state).messages;
      const otherSent = truncate(otherMessages, 128_000, 500, 1_000, other).messages;
      reconcile([source], state);
      expect(replayToolResultPromptProjections([source], state)).toEqual(sent);
      if (mode === "deep") {
        source = freezeJsonSnapshot({ ...source, content: [{ type: "text", text: "rewritten" }] });
      } else {
        block.text = "rewritten";
      }
      reconcile([source], state);
      reconcile(otherMessages, other);
      expect(state.sourceHashByKey.size).toBe(0);
      expect(state.replacements.size).toBe(0);
      expect(replayToolResultPromptProjections([source], state)).toEqual([source]);
      expect(replayToolResultPromptProjections(otherMessages, other)).toEqual(otherSent);
    },
  );

  it.each(["cache-TTL", "aggregate"])(
    "replays %s bytes for a fork without pruning new results or changing parent state",
    (kind) => {
      const state = newState();
      const history = prunableHistory([
        tool({ id: "old", text: "a".repeat(100_000) }),
        tool({ id: "older", text: "c".repeat(100_000) }),
      ]);
      const sent =
        kind === "cache-TTL"
          ? project(history, { projectionState: state })
          : truncate(history, 128_000, 100_000, 1_000, state).messages;
      expect(toolText(sent, "old").length).toBeLessThan(100_000);
      const freshResult = tool({ id: "fresh", text: "b".repeat(100_000) });
      const before = structuredClone(state);

      expect(replayToolResultPromptProjections([...history, freshResult], state)).toEqual([
        ...sent,
        freshResult,
      ]);
      expect(state).toEqual(before);
      expect(toolText(history, "old")).toBe("a".repeat(100_000));
    },
  );

  it("preserves ordinary projected bytes across turn teardown and compaction", () => {
    const maxChars = 4_000;
    const sessionId = "ordinary-turn-teardown";

    using initialLease = retainState(sessionId);
    const state = initialLease.state.toolResults;
    const history: AgentMessage[] = [user("start")];
    let sent: AgentMessage[] = [];
    for (let batch = 0; batch < 3; batch++) {
      history.push(
        assistant(),
        tool({ id: `batch-${batch}`, text: `${batch}`.repeat(6_000), image: true }),
      );
      sent = truncate(history, 128_000, maxChars, 8_000, state).messages;
    }
    expect(sent.filter((message) => message.role === "toolResult")).toHaveLength(3);
    expect(toolText(sent, "batch-0")).toContain("truncated");
    expect(
      [0, 1, 2].reduce((sum, batch) => sum + toolText(sent, `batch-${batch}`).length, 0),
    ).toBeGreaterThan(8_000);
    const markerData = JSON.stringify(snapshot(state));
    const entries = checkpoint(JSON.parse(markerData));
    initialLease[Symbol.dispose]();
    using restoredLease = retainState(sessionId);
    const restored = restoredLease.state.toolResults;
    expect(restored).not.toBe(state);
    restore(restored, entries);
    expect(JSON.stringify(truncate(history, 128_000, maxChars, 8_000, restored).messages)).toBe(
      JSON.stringify(sent),
    );
    const compacted = [user("summary"), ...history.slice(-2)];
    reconcile(compacted, restored);
    expect(restored).toMatchObject({ frozen: { size: 1 }, replacements: { size: 1 } });
    const compactedSnapshot = snapshot(restored);
    expect(JSON.stringify(compactedSnapshot)).not.toContain("batch-0");
    const reopened = newState();
    restore(reopened, [{ ...entries[0], data: compactedSnapshot }]);
    expect(truncate(compacted, 128_000, maxChars, 8_000, reopened).messages).toEqual([
      user("summary"),
      ...sent.slice(-2),
    ]);
  });

  it.each(["soft", "hard"] as const)(
    "replays %s pruning after TTL refresh and restart, until compaction/reset",
    async (mode) => {
      const sessionId = `cache-ttl-${mode}`;
      clearEmbeddedSessionPromptStates([sessionId]);

      const messages = prunableHistory(
        Array.from({ length: mode === "hard" ? 18 : 1 }, (_, index) =>
          tool({ id: `tool-${index}`, text: `${index}:` + "x".repeat(6_000), image: true }),
        ),
      );
      using initialLease = retainState(sessionId);
      const state = initialLease.state.toolResults;
      truncate(messages, 1_000, 5_500, 100_000, state);
      let pruningRounds = 0;
      const options = { projectionState: state, onPruned: () => pruningRounds++ };
      const first = project(messages, options);
      expect(toolText(first, "tool-0")).toContain(
        mode === "hard" ? "content cleared" : "Tool result trimmed",
      );
      const second = project(messages, { ...options, lastCacheTouchAt: NOW });
      expect(second).toEqual(first);
      expect(pruningRounds).toBe(1);
      const sent = truncate(second, 1_000, 2_500, 100_000, state).messages;
      expect(truncate(messages, 1_000, 2_500, 100_000, state).messages).toEqual(sent);
      const entries: { type: string; customType: string; data: unknown }[] = [];
      const sessionManager = {
        getEntries: () => entries,
        appendCustomEntryAsync: async (customType: string, data: unknown) => {
          const serialized = JSON.stringify(data);
          entries.push({ type: "custom", customType, data: JSON.parse(serialized) });
        },
      };
      using _ = vi.spyOn(Date, "now").mockReturnValueOnce(NOW);
      await appendAttemptCacheTtlIfNeeded({
        sessionManager,
        config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
        isCacheTtlEligibleProvider: () => true,
        toolResultPromptProjectionState: state,
      });
      expect(entries.at(-1)?.data).toMatchObject({
        timestamp: NOW,
        prunedToolResults: expect.arrayContaining([
          expect.objectContaining({ key: expect.stringContaining("tool-0"), mode }),
        ]),
      });
      // The marker carries keys only; pruned bytes never enter the transcript.
      expect(JSON.stringify(entries.at(-1)?.data)).not.toContain("x".repeat(20));
      clearEmbeddedSessionPromptStates([sessionId]);
      using restartedLease = retainState(sessionId);
      const restarted = restartedLease.state.toolResults;
      restore(restarted, entries);
      const restored = project(messages, {
        projectionState: restarted,
        lastCacheTouchAt: NOW,
        onPruned: () => pruningRounds++,
      });
      expect(restored).toEqual(first);
      expect(pruningRounds).toBe(1);
      expect(truncate(restored, 1_000, 2_500, 100_000, restarted).messages).toEqual(sent);
      const compacted = [user("summary"), ...messages.slice(-4)];
      reconcile(compacted, restarted);
      expect(restarted.replacements.size).toBe(0);
      restore(restarted, entries);
      project(compacted, { projectionState: restarted, lastCacheTouchAt: NOW });
      expect(restarted).toMatchObject({
        replacements: { size: 0 },
        restoredCacheTtl: { size: 0 },
      });
      clearEmbeddedSessionPromptStates([sessionId]);
      using resetLease = retainState(sessionId);
      expect(resetLease.state.toolResults.replacements.size).toBe(0);
    },
  );

  it("keeps pruned bytes when a later result makes a tool identity ambiguous", () => {
    const messages = prunableHistory([tool({ id: "reused", text: "a".repeat(5_000) })]);
    const state = newState();
    const sent = project(messages, { projectionState: state });
    const entries = checkpoint(snapshot(state));
    const expanded = [...messages, tool({ id: "reused", text: "b".repeat(5_000) })];
    const continued = project(expanded, { projectionState: state, lastCacheTouchAt: NOW });
    expect(JSON.stringify(continued.slice(0, messages.length))).toBe(JSON.stringify(sent));
    const restarted = newState();
    restore(restarted, entries);
    const restored = project(expanded, { projectionState: restarted, lastCacheTouchAt: NOW });
    expect(JSON.stringify(restored)).toBe(JSON.stringify(continued));
  });

  it("preserves a restored soft projection with non-array content on later replay", () => {
    const state = newState();
    restore(state, checkpoint({ prunedToolResults: [{ key: "tool:old:42", mode: "soft" }] }));
    // SAFETY: older malformed plugin content is handled by the existing replay guard.
    const original = freezeJsonSnapshot({
      ...tool({ id: "old" }),
      content: null,
    }) as unknown as AgentMessage;
    truncate([original], 128_000, 5_000, 20_000, state);
    const result = truncate(
      [freezeJsonSnapshot({ ...original, content: [] }) as AgentMessage],
      128_000,
      5_000,
      20_000,
      state,
    );
    expect(result.messages[0]).toMatchObject({ role: "toolResult", content: null });
  });

  it.each(["server", "TTL"])(
    "gates new %s pruning rounds without undoing live or restored projections",
    (owner) => {
      const state = newState();
      const history = prunableHistory([tool({ id: "old", text: "a".repeat(5_000) })]);
      const first = project(history, { projectionState: state });
      const entries = checkpoint(snapshot(state));
      const expanded = addNewRound(history);
      const gate = owner === "server" ? { pruneNewRounds: false } : { lastCacheTouchAt: NOW };
      const live = project(expanded, { projectionState: state, ...gate });
      expect(toolText(live, "old")).toBe(toolText(first, "old"));
      expect(toolText(live, "new")).toBe("b".repeat(5_000));
      if (owner === "server") {
        const restarted = newState();
        restore(restarted, entries);
        const restored = project(expanded, { projectionState: restarted, ...gate });
        expect(toolText(restored, "old")).toBe(toolText(first, "old"));
        expect(toolText(restored, "new")).toBe("b".repeat(5_000));
      } else {
        const expired = project(expanded, {
          projectionState: state,
          lastCacheTouchAt: NOW,
          now: NOW + 300_000,
        });
        expect(toolText(expired, "old")).toBe(toolText(first, "old"));
        expect(toolText(expired, "new")).toContain("[Tool result trimmed:");
      }
    },
  );

  it("normalizes TTL, hard-clear, and deny-first tool matching once", () => {
    expect(resolveCacheTtlPruningSettings(undefined)).toBeUndefined();
    expect(resolveCacheTtlPruningSettings({ mode: "off" })).toBeUndefined();
    expect(settings({ mode: "cache-ttl", ttl: "invalid" }).ttlMs).toBe(300_000);
    expect(settings({ mode: "cache-ttl", ttl: "1h" }).ttlMs).toBe(3_600_000);

    const configured = settings({
      mode: "cache-ttl",
      tools: { allow: ["READ*"], deny: ["read_secret"] },
      hardClear: { enabled: false, placeholder: "  custom  " },
    });
    expect(configured).toMatchObject({ hardClear: false, placeholder: "custom" });
    expect(configured.isToolPrunable("read_file")).toBe(true);
    expect(configured.isToolPrunable("READ_SECRET")).toBe(false);
    expect(configured.isToolPrunable("exec")).toBe(false);
    expect(settings().isToolPrunable("anything")).toBe(true);
  });

  it("replaces images and serializes malformed text before hard eligibility", () => {
    const malformed = { payload: "m".repeat(5_000) };
    const result = project(prunableHistory([tool({ id: "image", text: malformed, image: true })]), {
      contextWindowTokens: 4_000,
    });
    const text = toolText(result, "image");
    expect(text).toContain("[image removed during context pruning]");
    expect(text).toContain("[Tool result trimmed:");
  });

  it("drops old thinking only for pressure estimation", () => {
    const messages = prunableHistory([tool({ id: "thinking", text: "x".repeat(4_001) })]);
    messages[1] = assistant([
      { type: "thinking", thinking: "hidden", thinkingSignature: "s".repeat(40_000) },
      { type: "text", text: { malformed: "m".repeat(40_000) } },
      { type: "text", text: "done" },
    ]);
    expect(toolText(project(messages, { contextWindowTokens: 20_000 }), "thinking")).toContain(
      "[Tool result trimmed:",
    );
    expect(
      project(messages, { contextWindowTokens: 20_000, dropThinkingBlocksForEstimate: true }),
    ).toBe(messages);
  });
});
