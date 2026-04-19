import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { __testing, readLatestAssistantReply } from "./run-wait.js";
import { TOOL_RESULT_SUMMARY_KIND, TOOL_SUMMARY_KIND } from "./subagent-tool-persist.js";

describe("readLatestAssistantReply integration", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    __testing.setDepsForTest({
      callGateway: async (opts) => await callGatewayMock(opts),
    });
  });

  it("returns undefined when chat.history only contains persisted tool fragments", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: '[tool: Bash] {"command":"date"}' }],
          timestamp: 1,
          __openclaw: { kind: TOOL_SUMMARY_KIND, toolName: "Bash" },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "[result] ok" }],
          timestamp: 2,
          __openclaw: { kind: TOOL_RESULT_SUMMARY_KIND, toolName: "Bash" },
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBeUndefined();
  });
});
