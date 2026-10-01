import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { applyInputProvenanceToUserMessage } from "../sessions/input-provenance.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { attachRuntimeUserTurnTranscriptContext } from "../sessions/user-turn-transcript-runtime-context.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type PersistedToolResultMessage = ToolResultMessage & { details: Record<string, unknown> };
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(resetGlobalHookRunner);

const createGuardedSession = () =>
  guardSessionManager(SessionManager.inMemory(), { agentId: "main", sessionKey: "main" });
function appendToolResultDetails(
  sm: SessionManager,
  details: Record<string, unknown>,
  text = "visible output stays small",
  toolName = "exec",
) {
  sm.appendMessage(
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: "call_1", name: toolName, arguments: {} }],
    }),
  );
  sm.appendMessage({ ...makeTextToolResult("call_1", "", text, false, 1), details });
}
function hasRecordDetails(message: ToolResultMessage): message is PersistedToolResultMessage {
  return (
    typeof message.details === "object" &&
    message.details !== null &&
    !Array.isArray(message.details)
  );
}
function requirePersistedToolResult(sm: SessionManager) {
  const message = sm
    .getEntries()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
    .find((item) => item.role === "toolResult");
  if (!message || !hasRecordDetails(message)) {
    throw new Error("expected persisted toolResult with object details");
  }
  return message;
}
const toolResultText = (message: ToolResultMessage) =>
  message.content.find((block) => block.type === "text")?.text;

function installHook(
  hookName: "tool_result_persist" | "before_message_write",
  handler: (event: { message: AgentMessage }) => { message: AgentMessage } | undefined,
) {
  const registry = createEmptyPluginRegistry();
  registry.typedHooks.push({ pluginId: "persist-fixture", hookName, handler, source: "test" });
  initializeGlobalHookRunner(registry);
}

function expectPersistedToolResultTextCapped(sm: SessionManager) {
  const text = toolResultText(requirePersistedToolResult(sm));
  expect(text?.length).toBeLessThanOrEqual(120);
  expect(text).toContain("truncated");
}
function expectPersistedToolResultDetailsCapped(sm: SessionManager) {
  const { details } = requirePersistedToolResult(sm);
  expect(details.persistedDetailsTruncated).toBe(true);
  expect(details.aggregated).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThan(8_192);
}

describe("session persistence hooks", () => {
  it.each(["tool_result_persist", "before_message_write"] as const)(
    "caps text and details expanded by %s",
    (hook) => {
      installHook(hook, ({ message }) =>
        message.role === "toolResult"
          ? {
              message: {
                ...message,
                content: [{ type: "text", text: "y".repeat(5000) }],
                details: { status: "completed", aggregated: "x".repeat(150000) },
              },
            }
          : undefined,
      );
      const sm = guardSessionManager(SessionManager.inMemory(), {
        agentId: "main",
        sessionKey: "main",
        contextWindowTokens: 100,
      });
      appendToolResultDetails(sm, { big: "x".repeat(10_000) }, "ok", "read");
      expectPersistedToolResultTextCapped(sm);
      expectPersistedToolResultDetailsCapped(sm);
    },
  );

  it("redacts small recursive details, including keys and depth-limited branches", () => {
    const tokenValue = "abcdefghijklmnopqrstuvwx1234567890";
    const bearerValue = "bearerdiagnosticvalue1234567890";
    const adjacentLongGithubToken = "ghp_" + "a".repeat(5_000);
    let deepDetails: Record<string, unknown> = { token: tokenValue };
    for (let index = 0; index < 10; index++) {
      deepDetails = { child: deepDetails };
    }
    const sm = createGuardedSession();
    appendToolResultDetails(sm, {
      status: "completed",
      token: tokenValue,
      card_number: 4242424242424242,
      authToken: [tokenValue],
      adjacentLongGithubToken: "x".repeat(1_000) + adjacentLongGithubToken + " z",
      ["https://example.test/callback?token=" + tokenValue]: "ok",
      deepDetails,
      nested: {
        apiKey: { value: bearerValue },
        stdout: "Authorization: Bearer " + bearerValue,
      },
    });
    const toolResult = requirePersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult.details);
    expect(toolResultText(toolResult)).toBe("visible output stays small");
    for (const retained of ["Bearer", "…", "token=", "***", "max depth exceeded"]) {
      expect(serialized).toContain(retained);
    }
    for (const secret of [
      tokenValue,
      bearerValue,
      adjacentLongGithubToken,
      "a".repeat(100),
      "4242424242424242",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("applies in-memory redaction config to persisted details", () => {
    const customSecret = "customsecret=abcdef1234567890ghij";
    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "main",
      config: {
        logging: {
          redactPatterns: [String.raw`customsecret=([^\s]+)`],
        },
      },
    });
    appendToolResultDetails(
      sm,
      {
        diagnostic: customSecret,
      },
      customSecret,
    );

    const toolResult = requirePersistedToolResult(sm);
    const serialized = JSON.stringify(toolResult);
    expect(serialized).toContain("customsecret=abcdef…ghij");
    expect(serialized).not.toContain(customSecret);
  });

  it("redacts oversized summary fields without leaking lookahead or splitting surrogate pairs", () => {
    const tokenValue = "abcdefghijklmnopqrstuvwx1234567890";
    const boundaryGhToken = "ghp_" + "a".repeat(36);
    const postBoundarySecret = "UNREDACTED_AFTER_LIMIT_SECRET";
    const shrinkPrefix =
      Array.from({ length: 20 }, () => "GITHUB_TOKEN=" + tokenValue).join(" ") + " ";
    const scanPrefix = Array.from({ length: 5 }, () => "ghp_" + "a".repeat(140)).join(" ");
    const sm = createGuardedSession();
    appendToolResultDetails(sm, {
      status: { state: "completed", token: tokenValue },
      sessionId: "exec-1",
      ["https://example.test/callback?token=" + tokenValue]: "ok",
      aggregated: "x".repeat(120_000),
      tail:
        "GITHUB_TOKEN=" +
        tokenValue +
        " " +
        "x".repeat(1_940) +
        " " +
        boundaryGhToken +
        " GITHUB_TOKEN=" +
        "a".repeat(5_000) +
        ' {"token":"' +
        "b".repeat(5_000) +
        '"}',
      name: "x".repeat(1_000) + '{"token":"' + "r".repeat(10_000) + "z".repeat(1_000),
      cwd:
        shrinkPrefix +
        "x".repeat(2_300 - shrinkPrefix.length) +
        postBoundarySecret +
        "z".repeat(5_000),
      fullOutputPath: "u".repeat(1_487) + "😀" + "v".repeat(9_000),
      truncation: scanPrefix + "x".repeat(1_999 - scanPrefix.length) + "😀" + "z".repeat(9_000),
      sessions: [
        {
          sessionId: "proc-1",
          status: { state: "completed", token: tokenValue },
          command: "x".repeat(490) + " --token " + tokenValue + " " + "y".repeat(6_000),
          aggregated: "a".repeat(80_000),
          tail: "z".repeat(8_000),
        },
      ],
    });
    const toolResult = requirePersistedToolResult(sm);
    const details = toolResult.details;
    const serialized = JSON.stringify(details);
    expect(toolResultText(toolResult)).toBe("visible output stays small");
    expect(details.persistedDetailsTruncated).toBe(true);
    expect(serialized).toContain("token=***");
    for (const value of [details.tail, details.name, details.cwd]) {
      expect(value).toContain("partial secret span omitted");
      expect(value).toContain("boundary overlap omitted");
    }
    for (const value of [details.fullOutputPath, details.truncation]) {
      expect(value).toContain("boundary overlap omitted");
      expect(value).not.toMatch(LONE_SURROGATE_RE);
    }
    for (const secret of [
      tokenValue,
      boundaryGhToken.slice(0, 12),
      postBoundarySecret,
      "a".repeat(100),
      "b".repeat(100),
      "r".repeat(100),
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("redacts retained structured fields in fallback oversized details summaries", () => {
    const tokenValue = "fallback-token-abcdefghijklmnopqrstuv";
    const spill = Object.freeze({
      path: "/tmp/web-fetch-output",
      chars: 2_000_000,
      truncated: true,
    });
    const sm = createGuardedSession();
    appendToolResultDetails(sm, {
      status: { state: "completed", token: tokenValue },
      sessionId: "exec-1",
      cwd: "/tmp/".concat("workspace/".repeat(400)),
      name: "oversized fallback command ".repeat(200),
      fullOutputPath: "/tmp/".concat("output/".repeat(400)),
      success: true,
      disabled: false,
      unavailable: false,
      error: "upstream unavailable",
      spilledChars: 2_000_000,
      spillTruncated: true,
      spill,
      aggregated: "x".repeat(120_000),
      tail: "tail ".repeat(800),
      sessions: Array.from({ length: 10 }, (_, i) => ({
        sessionId: `proc-${i}`,
        status: "completed",
        command: `node script-${i}.js ${"x".repeat(6_000)}`,
      })),
    });

    const toolResult = requirePersistedToolResult(sm);
    const details = toolResult.details;
    const serialized = JSON.stringify(details);
    expect(details.persistedDetailsTruncated).toBe(true);
    expect(details.finalDetailsTruncated).toBe(true);
    expect(details).toMatchObject({ success: true, disabled: false, unavailable: false });
    expect(details.error).toBe("upstream unavailable");
    expect(details.status).toMatchObject({ token: "***" });
    expect(details.spilledChars).toBe(2_000_000);
    expect(details.spillTruncated).toBe(true);
    expect(details.spill).toEqual(spill);
    expect(serialized).not.toContain(tokenValue);
  });

  it("caps oversized toolResult details without serializing the original payload", () => {
    const sm = createGuardedSession();
    const oversizedDetails = { aggregated: "x".repeat(200_000) };
    const originalStringify = JSON.stringify;
    const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
      if (value === oversizedDetails) {
        throw new Error("unbounded original details stringify");
      }
      return originalStringify(value, ...args);
    });

    try {
      appendToolResultDetails(sm, oversizedDetails);
    } finally {
      stringifySpy.mockRestore();
    }

    const toolResult = requirePersistedToolResult(sm);
    expect(toolResultText(toolResult)).toBe("visible output stays small");
    expectPersistedToolResultDetailsCapped(sm);
  });

  it("caps wide toolResult details without materializing every entry up front", () => {
    const sm = createGuardedSession();
    const wideDetails: Record<string, unknown> = {
      status: "completed",
      sessionId: "exec-wide",
    };
    for (let index = 0; index < 20_000; index += 1) {
      wideDetails[`debug_${index}`] = `value-${index}`;
    }
    const originalEntries = Object.entries;
    const originalKeys = Object.keys;
    const entriesSpy = vi.spyOn(Object, "entries").mockImplementation((value) => {
      if (value === wideDetails) {
        throw new Error("wide details entries materialized");
      }
      return originalEntries(value);
    });
    const keysSpy = vi.spyOn(Object, "keys").mockImplementation((value) => {
      if (value === wideDetails) {
        throw new Error("wide details keys materialized");
      }
      return originalKeys(value);
    });

    try {
      appendToolResultDetails(sm, wideDetails);
    } finally {
      entriesSpy.mockRestore();
      keysSpy.mockRestore();
    }

    const toolResult = requirePersistedToolResult(sm);
    const details = toolResult.details;
    expect(details.persistedDetailsTruncated).toBe(true);
    expect(details.originalDetailKeys).toContain("status");
    expect(details.originalDetailKeys).toContain("sessionId");
    expect(details.originalDetailKeys).toContain("debug_0");
  });

  it("reapplies the details cap after redaction expands hook details", () => {
    const deepItems = Array.from({ length: 2_000 }, () => ({}));
    const hookDetails = { a: { b: { c: { d: { e: { f: { g: deepItems } } } } } } };
    installHook("tool_result_persist", ({ message }) =>
      message.role === "toolResult" ? { message: { ...message, details: hookDetails } } : undefined,
    );
    const sm = createGuardedSession();
    appendToolResultDetails(sm, { big: "x".repeat(10_000) }, "ok", "read");
    expectPersistedToolResultDetailsCapped(sm);
  });
  it("refreshes skipped write hooks when reusing a session manager", () => {
    installHook("before_message_write", ({ message }) =>
      message.role === "user" ? { message: { ...message, content: "hooked" } } : undefined,
    );
    const sm = SessionManager.inMemory();
    for (const skipBeforeMessageWriteHooks of [true, false, true]) {
      guardSessionManager(sm, { skipBeforeMessageWriteHooks });
      sm.appendMessage(makeUserMessage("original", 1));
    }
    expect(
      sm
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
        ),
    ).toEqual(["original", "hooked", "original"]);
  });
});

const call = makeAgentAssistantMessage({
  content: [{ type: "toolCall", id: "call_order", name: "read", arguments: {} }],
  stopReason: "toolUse",
});
const result = makeTextToolResult("call_order", "read", "success", false, 1);
const entries = (manager: SessionManager) =>
  manager.getEntries().filter((entry) => entry.type === "message");

describe("tool-result persistence ordering", () => {
  it("tracks a committed assistant call even when its callback throws", () => {
    const manager = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(manager, {
      onMessagePersisted(message) {
        if (message.role === "assistant") {
          throw new Error("assistant callback failed after commit");
        }
      },
    });
    expect(() => manager.appendMessage(call)).toThrow("assistant callback failed after commit");
    expect(guard.getPendingIds()).toEqual(["call_order"]);
    guard.flushPendingToolResults();
    expect(entries(manager)).toMatchObject([
      { message: call },
      { message: { role: "toolResult", toolCallId: "call_order", isError: true } },
    ]);
  });

  it("does not repair a committed result during a reentrant user append", () => {
    const manager = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(manager, {
      onMessagePersisted(message) {
        if (message.role === "toolResult" && !message.isError) {
          manager.appendMessage(makeUserMessage("next message", 1));
        }
      },
    });
    manager.appendMessage(call);
    manager.appendMessage(result);
    guard.flushPendingToolResults();
    expect(guard.getPendingIds()).toEqual([]);
    expect(
      entries(manager).flatMap(({ message }) => (message.role === "toolResult" ? [message] : [])),
    ).toEqual([result]);
  });

  it("keeps an uncommitted result pending when the raw append fails", () => {
    const manager = SessionManager.inMemory();
    const append = manager.appendMessageWithTranscriptAnchor.bind(manager);
    const spy = vi
      .spyOn(manager, "appendMessageWithTranscriptAnchor")
      .mockImplementation((message, options) => {
        if (message.role === "toolResult" && !message.isError) {
          throw new Error("append failed before commit");
        }
        return append(message, options);
      });
    try {
      const guard = installSessionToolResultGuard(manager);
      manager.appendMessage(call);
      expect(() => manager.appendMessage(result)).toThrow("append failed before commit");
      expect(guard.getPendingIds()).toEqual(["call_order"]);
      guard.flushPendingToolResults();
      expect(entries(manager)).toMatchObject([
        { message: call },
        { message: { role: "toolResult", toolCallId: "call_order", isError: true } },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

const listeners: Array<() => void> = [];
afterEach(() => {
  for (const unsubscribe of listeners.splice(0)) {
    unsubscribe();
  }
  closeOpenClawAgentDatabasesForTest();
});
async function openPersistedSessionManager() {
  const root = tempDirs.make("openclaw-transcript-visibility-");
  const target = {
    agentId: "main",
    sessionId: "visibility-session",
    sessionKey: "agent:main:visibility-session",
    storePath: path.join(root, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
  return { target, sessionManager: SessionManager.open(target, root) };
}
const assistantText = (text: string, timestamp: number) =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp });

describe("guardSessionManager transcript visibility", () => {
  it("keeps progress refreshes in model context while hiding transcript updates", async () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
    const { sessionManager, target } = await openPersistedSessionManager();
    const guarded = guardSessionManager(sessionManager, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      trigger: "user",
      inputProvenance: { kind: "internal_system", sourceTool: "progress_card_refresh" },
    });
    guarded.appendMessage(makeUserMessage("Review the worker result", 1));
    guarded.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "read-result", name: "read", arguments: {} }],
        stopReason: "toolUse",
        timestamp: 2,
      }),
    );
    guarded.appendMessage(
      makeTextToolResult("read-result", "read", "The regression is fixed", false, 3),
    );
    guarded.appendMessage(assistantText("The repair passed validation", 4));
    const persisted = SessionManager.open(target).buildSessionContext().messages;
    expect(persisted).toMatchObject([
      { role: "user", content: "Review the worker result" },
      { role: "assistant", content: [{ type: "toolCall", id: "read-result" }] },
      { role: "toolResult", content: [{ type: "text", text: "The regression is fixed" }] },
      { role: "assistant", content: [{ type: "text", text: "The repair passed validation" }] },
    ]);
    expect(persisted.map((message) => Reflect.get(message, "display"))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(({ message }) => Reflect.get(message!, "display") === false)).toBe(true);
  });

  it("preserves per-message provenance and run visibility across reused runs", async () => {
    const { sessionManager, target } = await openPersistedSessionManager();
    const childProvenance = {
      kind: "inter_session" as const,
      sourceTool: "  sessions_send\t",
      sourceRole: "subagent" as const,
    };
    guardSessionManager(sessionManager, { runId: "human-run" }).appendMessage(
      applyInputProvenanceToUserMessage(
        makeUserMessage("Worker finished the reproduction", 1),
        childProvenance,
      ),
    );
    sessionManager.appendMessage(assistantText("I found the cause of your bug", 2));
    guardSessionManager(sessionManager, {
      runId: "coordination-run",
      inputProvenance: childProvenance,
    }).appendMessage(
      applyInputProvenanceToUserMessage(makeUserMessage("Answer my follow-up", 3), {
        kind: "external_user",
      }),
    );
    sessionManager.appendMessage(assistantText("Report received", 4));
    guardSessionManager(sessionManager, {
      runId: "completion-run",
      inputProvenance: { ...childProvenance, sourceTool: "subagent_announce" },
    }).appendMessage(assistantText("Your bug is fixed and tested", 5));
    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toHaveLength(5);
    expect(messages.map((message) => Reflect.get(message, "display") === false)).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(messages[0]).toMatchObject({
      content: "Worker finished the reproduction",
      provenance: childProvenance,
    });
    expect(messages[2]).toMatchObject({
      content: "Answer my follow-up",
      provenance: { kind: "external_user" },
    });
  });

  it("keeps the user-turn recorder attached when hiding memory maintenance", () => {
    const sm = SessionManager.inMemory();
    const markRuntimePersisted = vi.fn();
    const recorder = {
      markBlocked: vi.fn(),
      markRuntimePersisted,
    } as unknown as UserTurnTranscriptRecorder;
    const runtimeMessage = makeUserMessage("Pre-compaction memory flush", 1);
    attachRuntimeUserTurnTranscriptContext(runtimeMessage, {
      message: { ...runtimeMessage },
      recorder,
    });
    guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:memory",
      trigger: "memory",
    }).appendMessage(runtimeMessage);
    expect(markRuntimePersisted).toHaveBeenCalledTimes(1);
    expect(markRuntimePersisted.mock.calls[0]?.[0]).toMatchObject({ display: false, role: "user" });
    expect(markRuntimePersisted.mock.calls[0]?.[2]).toEqual({ appended: true });
  });
});
