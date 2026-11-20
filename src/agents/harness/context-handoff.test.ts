import { expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { BOUNDED_CONTEXT_NOTICE } from "../../context-engine/transcript-byte-limit.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { parseCliReseedPrompt } from "../cli-runner/reseed-envelope.js";
import { buildCliSessionHistoryPrompt } from "../cli-runner/session-history.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { bindHandoff, selectHandoff, type HandoffItem } from "./context-handoff.js";

const item = (id: string, role: string, text: string): HandoffItem<string> => {
  const bytes = Buffer.byteLength(text) + 2;
  return { id, role, value: `${role}:${text}`, bytes, tokens: Math.ceil(bytes / 4) };
};

it("keeps summary, first goal and newest intact turns, and names omitted messageIds", () => {
  const summary = item("sum-0", "compactionSummary", "Earlier summary of project setup.");
  const items = [
    item("msg-1", "user", "Original task: build unified context handoff."),
    ...Array.from({ length: 19 }, (_, index) =>
      item(
        `msg-${index + 2}`,
        index % 2 ? "user" : "assistant",
        `turn ${index} ${"x".repeat(180)}`,
      ),
    ),
  ];
  const selection = selectHandoff({
    items,
    summary,
    maxBytes: 3_000,
    maxTokens: 750,
    sessionKey: "agent:main:test",
  });
  expect(selection.omittedCount).toBeGreaterThan(0);
  expect(selection.values.slice(0, 2)).toEqual([summary.value, items[0]!.value]);
  expect(selection.values.at(-1)).toBe(items.at(-1)!.value);
  expect(selection.values).toContain(items.at(-2)!.value);
  expect(selection.notice).toContain('sessions_history({ sessionKey: "agent:main:test"');
  // The newest omitted turn is named so the model can pull it back.
  const omitted = items.filter((i) => !selection.values.includes(i.value));
  expect(selection.notice).toContain(omitted.at(-1)!.id);
  // Every value is intact: no message is sliced to fit.
  expect(
    selection.values.every((value) => [summary, ...items].some((i) => i.value === value)),
  ).toBe(true);
});

it("delivers no history when the allowance cannot fit the omission notice", () => {
  const items = [item("a", "user", "goal".repeat(50)), item("b", "assistant", "done".repeat(50))];
  expect(
    selectHandoff({ items, maxBytes: 120, maxTokens: 30, sessionKey: "agent:main:tiny" }),
  ).toEqual({ values: [], omittedCount: 2, notice: undefined });
});

it("returns everything with no notice when the history fits", () => {
  const items = [item("a", "user", "goal"), item("b", "assistant", "done")];
  expect(selectHandoff({ items, maxBytes: 4_000, maxTokens: 1_000 })).toEqual({
    values: items.map((i) => i.value),
    omittedCount: 0,
    notice: undefined,
  });
});

it("renders a CLI handoff the reseed parser accepts, without a tool hint when the tool is absent", () => {
  const rendered = buildCliSessionHistoryPrompt({
    messages: [
      { id: "e-1", role: "user", content: "Original goal" },
      { id: "e-2", role: "assistant", content: "a".repeat(600) },
      { id: "e-3", role: "user", content: "b".repeat(600) },
      { id: "e-4", role: "assistant", content: "Latest reply" },
    ],
    prompt: "Current question",
    maxHistoryChars: 1_000,
  });
  expect(parseCliReseedPrompt(rendered!)).toEqual({
    kind: "legacy",
    userMessage: "Current question",
  });
  expect(rendered).toContain("Original goal");
  expect(rendered).toContain("Latest reply");
  expect(rendered).toContain("omitted");
  expect(rendered).not.toContain("sessions_history");
});

it("bounds a tool-heavy transcript without a model call and tolerates a failing observer", async () => {
  await withOpenClawTestState({ label: "handoff-bound" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionId: "handoff-bound",
      sessionKey: "agent:main:handoff-bound",
      storePath: state.statePath("sessions.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    await manager.appendMessageAsync(makeUserMessage("Goal: fix Codex delta handoff", 10));
    for (let i = 1; i <= 12; i += 1) {
      await manager.appendMessageAsync(
        makeAssistantMessageFixture({
          content: [{ type: "toolCall", id: `call-${i}`, name: "exec", arguments: {} }],
          stopReason: "toolUse",
        }),
      );
      await manager.appendMessageAsync({
        role: "toolResult",
        toolCallId: `call-${i}`,
        toolName: "exec",
        content: [{ type: "text", text: `output ${i} ${"z".repeat(4_000)}` }],
        isError: false,
        timestamp: 10 + i,
      });
      await manager.appendMessageAsync(makeUserMessage(`follow-up ${i}`, 10 + i));
    }
    const observer = vi.fn().mockRejectedValue(new Error("observer boom"));
    const prepareContextMedia = vi.fn(async ({ message }: { message: AgentMessage }) => ({
      text: message.role === "assistant" ? "[saved-image]" : undefined,
      images: [],
      hasImageAttachments: false,
    }));
    const bound = bindHandoff(
      {
        sessionTarget: target,
        workspaceDir: state.workspaceDir,
        config: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "2mb" } } } },
        contextTokenBudget: 100_000,
        onAgentEvent: observer,
        runId: "handoff-run",
      },
      () => {},
      async (run) => run(),
      undefined,
      { capabilities: { prepareContextMedia } },
    );
    const published: unknown[] = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "handoff-run") {
        published.push(event);
      }
    });
    const seeded = await bound!.prepareBoundedSeed!({
      assertCurrent: () => {},
      tokenBudget: 1_500,
      historyToolAvailable: true,
    }).finally(stop);
    // Without the tool, the notice still names omitted turns but no recovery call.
    const toolless = await bound!.prepareBoundedSeed!({
      assertCurrent: () => {},
      tokenBudget: 1_500,
    });
    expect(JSON.stringify(toolless[0])).toContain("[OpenClaw context handoff]");
    expect(JSON.stringify(toolless[0])).not.toContain("sessions_history");
    expect(JSON.stringify(seeded[0])).toContain("[OpenClaw context handoff]");
    expect(JSON.stringify(seeded[0])).toContain("sessions_history");
    // Omitted turns are named by the transcript entry ids sessions_history accepts.
    expect(JSON.stringify(seeded[0])).toMatch(/Newest omitted messageIds: [0-9a-f-]{8,}/);
    expect(JSON.stringify(seeded)).toContain("follow-up 12");
    const data = { phase: "context_bounded", message: BOUNDED_CONTEXT_NOTICE };
    expect(observer).toHaveBeenCalledWith({ stream: "compaction", data });
    // Channel conversations' Control UI panes observe the Gateway event, not the observer.
    expect(published).toContainEqual(
      expect.objectContaining({ sessionKey: target.sessionKey, stream: "compaction", data }),
    );
    expect(prepareContextMedia).toHaveBeenCalled();
  });
});

it("fits an active exchange against the delivery allowance, not the history cap", async () => {
  await withOpenClawTestState({ label: "handoff-active" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionId: "handoff-active",
      sessionKey: "agent:main:handoff-active",
      storePath: state.statePath("sessions.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    await manager.appendMessageAsync(makeUserMessage("Goal: keep the refresh exchange", 1));
    const exchange: AgentMessage[] = [
      makeUserMessage("Run the long tool", 2),
      {
        role: "toolResult",
        toolCallId: "call-big",
        toolName: "exec",
        content: [{ type: "text", text: "y".repeat(80_000) }],
        isError: false,
        timestamp: 3,
      },
    ];
    const bound = bindHandoff(
      {
        sessionTarget: target,
        workspaceDir: state.workspaceDir,
        config: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "2mb" } } } },
        contextTokenBudget: 100_000,
        pluginRuntimeRefreshMessages: exchange,
      },
      () => {},
      async (run) => run(),
    );
    const seeded = await bound!.prepareBoundedSeed!({ assertCurrent: () => {} });
    expect(seeded.slice(-2)).toEqual(exchange);
    expect(JSON.stringify(seeded)).toContain("Goal: keep the refresh exchange");
  });
});

it("refuses once at start when the run authority is gone", async () => {
  await withOpenClawTestState({ label: "handoff-revoked" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionId: "handoff-revoked",
      sessionKey: "agent:main:handoff-revoked",
      storePath: state.statePath("sessions.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const bound = bindHandoff(
      {
        sessionTarget: target,
        workspaceDir: state.workspaceDir,
        config: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: 4096 } } } },
      },
      () => {
        throw new Error("revoked at start");
      },
      async (run) => run(),
    );
    await expect(bound!.prepareBoundedSeed!({ assertCurrent: () => {} })).rejects.toThrow(
      "revoked at start",
    );
  });
});
