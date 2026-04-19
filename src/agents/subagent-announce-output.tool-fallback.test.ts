import { beforeAll, describe, expect, it, vi } from "vitest";
import { TOOL_SUMMARY_KIND } from "./subagent-tool-persist.js";

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

let subagentAnnounceOutputTesting: typeof import("./subagent-announce-output.js").__testing;
let readSubagentOutput: typeof import("./subagent-announce-output.js").readSubagentOutput;

beforeAll(async () => {
  const mod = await import("./subagent-announce-output.js");
  subagentAnnounceOutputTesting = mod.__testing;
  readSubagentOutput = mod.readSubagentOutput;
});

// Integration-ish test: mock the gateway's chat.history response to return ONLY
// tool_summary messages (no assistant text). Prior to this fix,
// readSubagentOutput would return undefined for that shape and the parent
// session would end up printing "(no output)". Assert we now return a
// non-empty fallback summary.
describe("readSubagentOutput with only tool fragments (regression for '(no output)')", () => {
  it("returns the [Subagent completed with tool calls only] fallback", async () => {
    const callGateway = vi.fn(async ({ method }: { method: string }) => {
      if (method === "chat.history") {
        return {
          messages: [
            { role: "user", content: "run date" },
            {
              role: "assistant",
              content: [{ type: "text", text: '[tool: Bash] {"command":"date"}' }],
              __openclaw: {
                kind: TOOL_SUMMARY_KIND,
                toolName: "Bash",
              },
            },
          ],
        };
      }
      return {};
    });
    subagentAnnounceOutputTesting.setDepsForTest({ callGateway: callGateway as never });
    try {
      const result = await readSubagentOutput("agent:builder:test");
      expect(result).toBeDefined();
      expect(result).toContain("[Subagent completed with tool calls only]");
      expect(result).toContain("[tool: Bash]");
      expect(result).not.toBe("(no output)");
    } finally {
      subagentAnnounceOutputTesting.setDepsForTest();
    }
  });
});
