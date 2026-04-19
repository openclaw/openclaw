import { beforeAll, describe, expect, it, vi } from "vitest";
import { TOOL_RESULT_SUMMARY_KIND, TOOL_SUMMARY_KIND } from "./subagent-tool-persist.js";

// Mock heavy runtime deps before importing the module under test
vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: vi.fn(),
  loadConfig: vi.fn(),
  loadSessionStore: vi.fn(),
  resolveAgentIdFromSessionKey: vi.fn(),
  resolveStorePath: vi.fn(),
}));
vi.mock("../auto-reply/tokens.js", () => ({
  isSilentReplyText: vi.fn(() => false),
  SILENT_REPLY_TOKEN: "__SILENT__",
}));
vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: vi.fn(),
}));
vi.mock("./tools/session-message-text.js", () => ({
  extractAssistantText: vi.fn(),
  sanitizeTextContent: vi.fn((s: string) => s),
}));
vi.mock("./tools/sessions-send-tokens.js", () => ({
  isAnnounceSkip: vi.fn(() => false),
}));

let __testingSubagentAnnounceOutput: typeof import("./subagent-announce-output.js").__testingSubagentAnnounceOutput;

beforeAll(async () => {
  const mod = await import("./subagent-announce-output.js");
  __testingSubagentAnnounceOutput = mod.__testingSubagentAnnounceOutput;
});

const TOOL_FRAGMENT_FALLBACK_PREFIX = "[Subagent completed with tool calls only]";

function buildToolFragmentMessage(opts: {
  kind: typeof TOOL_SUMMARY_KIND | typeof TOOL_RESULT_SUMMARY_KIND;
  text: string;
  toolName?: string;
}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: opts.text }],
    timestamp: Date.now(),
    __openclaw: {
      kind: opts.kind,
      ...(opts.toolName ? { toolName: opts.toolName } : {}),
    },
  };
}

describe("summarizeSubagentOutputHistory with tool fragments", () => {
  it("captures tool_summary and tool_result_summary into toolFragments", async () => {
    const { summarizeSubagentOutputHistory } = __testingSubagentAnnounceOutput;
    const messages = [
      { role: "user", content: "hi" },
      buildToolFragmentMessage({
        kind: TOOL_SUMMARY_KIND,
        text: '[tool: Bash] {"command":"date"}',
        toolName: "Bash",
      }),
      buildToolFragmentMessage({
        kind: TOOL_RESULT_SUMMARY_KIND,
        text: "[result] Mon Apr 19 2026",
      }),
    ];
    const snapshot = summarizeSubagentOutputHistory(messages);
    expect(snapshot.toolFragments).toHaveLength(2);
    expect(snapshot.toolFragments[0]?.kind).toBe(TOOL_SUMMARY_KIND);
    expect(snapshot.toolFragments[0]?.toolName).toBe("Bash");
    expect(snapshot.toolFragments[1]?.kind).toBe(TOOL_RESULT_SUMMARY_KIND);
    expect(snapshot.latestAssistantText).toBeUndefined();
    expect(snapshot.assistantFragments).toHaveLength(0);
  });

  it("does not treat tool fragments as the final assistant reply", async () => {
    const { summarizeSubagentOutputHistory, selectSubagentOutputText } =
      __testingSubagentAnnounceOutput;
    const messages = [
      { role: "user", content: "go" },
      buildToolFragmentMessage({
        kind: TOOL_SUMMARY_KIND,
        text: "[tool: Bash] {}",
        toolName: "Bash",
      }),
    ];
    const snapshot = summarizeSubagentOutputHistory(messages);
    const selected = selectSubagentOutputText(snapshot);
    expect(selected).toContain(TOOL_FRAGMENT_FALLBACK_PREFIX);
    expect(selected).toContain("[tool: Bash]");
  });

  it("prefers the real assistant text over toolFragments when both exist", async () => {
    const { summarizeSubagentOutputHistory, selectSubagentOutputText } =
      __testingSubagentAnnounceOutput;
    const messages = [
      buildToolFragmentMessage({
        kind: TOOL_SUMMARY_KIND,
        text: "[tool: Bash] {}",
        toolName: "Bash",
      }),
      {
        role: "assistant",
        content: [{ type: "text", text: "All done." }],
      },
    ];
    const snapshot = summarizeSubagentOutputHistory(messages);
    const selected = selectSubagentOutputText(snapshot);
    expect(selected).toBe("All done.");
  });

  it("caps the fallback at 5 fragments, newest last", async () => {
    const { summarizeSubagentOutputHistory, selectSubagentOutputText } =
      __testingSubagentAnnounceOutput;
    const messages = Array.from({ length: 10 }, (_, i) =>
      buildToolFragmentMessage({
        kind: TOOL_SUMMARY_KIND,
        text: `[tool: Bash] step-${i}`,
        toolName: "Bash",
      }),
    );
    const snapshot = summarizeSubagentOutputHistory(messages);
    const selected = selectSubagentOutputText(snapshot);
    expect(selected).toContain("step-5");
    expect(selected).toContain("step-9");
    expect(selected).not.toContain("step-0");
    expect(selected).not.toContain("step-4");
  });

  it("returns undefined when snapshot has no text/fragments", async () => {
    const { summarizeSubagentOutputHistory, selectSubagentOutputText } =
      __testingSubagentAnnounceOutput;
    const snapshot = summarizeSubagentOutputHistory([]);
    expect(selectSubagentOutputText(snapshot)).toBeUndefined();
  });
});
