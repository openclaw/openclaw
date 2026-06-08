import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as gatewayCallModule from "../gateway/call.js";
import {
  LOST_ACTIVE_EXECUTION_CONTEXT_ERROR,
  resolveStaleActiveSubagentOutcome,
} from "./subagent-lost-context-completion.js";

const CHILD_SESSION = "agent:main:subagent:child";

function assistantTextMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantStringMessage(text: string) {
  return { role: "assistant", content: text };
}

function toolCallOnlyMessage() {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
  };
}

describe("resolveStaleActiveSubagentOutcome", () => {
  let callGatewaySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    callGatewaySpy = vi.spyOn(
      (await import("../gateway/call.js")) as typeof gatewayCallModule,
      "callGateway",
    );
  });

  it("returns ok when child session has visible assistant text", async () => {
    callGatewaySpy.mockResolvedValue({
      messages: [assistantTextMessage("# ARCHITECTURE.md\nrelease readiness design")],
    });
    await expect(
      resolveStaleActiveSubagentOutcome({ childSessionKey: CHILD_SESSION }),
    ).resolves.toEqual({ status: "ok" });
  });

  it("returns lost-context error when chat.history returns no messages", async () => {
    callGatewaySpy.mockResolvedValue({ messages: [] });
    await expect(
      resolveStaleActiveSubagentOutcome({ childSessionKey: CHILD_SESSION }),
    ).resolves.toEqual({
      status: "error",
      error: LOST_ACTIVE_EXECUTION_CONTEXT_ERROR,
    });
  });

  it("returns lost-context error for silent reply token text", async () => {
    callGatewaySpy.mockResolvedValue({
      messages: [assistantTextMessage("NO_REPLY")],
    });
    await expect(
      resolveStaleActiveSubagentOutcome({ childSessionKey: CHILD_SESSION }),
    ).resolves.toEqual({
      status: "error",
      error: LOST_ACTIVE_EXECUTION_CONTEXT_ERROR,
    });
  });

  it("returns lost-context error when history only contains tool calls without visible output", async () => {
    callGatewaySpy.mockResolvedValue({
      messages: [toolCallOnlyMessage()],
    });
    await expect(
      resolveStaleActiveSubagentOutcome({ childSessionKey: CHILD_SESSION }),
    ).resolves.toEqual({
      status: "error",
      error: LOST_ACTIVE_EXECUTION_CONTEXT_ERROR,
    });
  });

  it("returns lost-context error when string-content assistant message is whitespace only", async () => {
    callGatewaySpy.mockResolvedValue({
      messages: [assistantStringMessage("   \n  ")],
    });
    await expect(
      resolveStaleActiveSubagentOutcome({ childSessionKey: CHILD_SESSION }),
    ).resolves.toEqual({
      status: "error",
      error: LOST_ACTIVE_EXECUTION_CONTEXT_ERROR,
    });
  });

  it("returns ok for assistant message with string content", async () => {
    callGatewaySpy.mockResolvedValue({
      messages: [assistantStringMessage("result text")],
    });
    await expect(
      resolveStaleActiveSubagentOutcome({ childSessionKey: CHILD_SESSION }),
    ).resolves.toEqual({ status: "ok" });
  });
});
