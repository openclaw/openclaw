import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession tool-only safety", () => {
  it("uses effective agent thresholds and ignores duplicate message_end events", () => {
    const steer = vi.fn(async () => undefined);
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      sessionKey: "agent:support:tool-only-threshold",
      config: {
        tools: {
          maxConsecutiveToolOnlyTurns: 99,
        },
        agents: {
          list: [
            {
              id: "support",
              tools: {
                maxConsecutiveToolOnlyTurns: 2,
              },
            },
          ],
        },
      },
      sessionExtras: { steer },
    });

    const firstToolOnlyMessage = {
      role: "assistant",
      content: [{ type: "toolCall", toolName: "read", toolCallId: "tool-1", args: {} }],
    } as AssistantMessage;
    const secondToolOnlyMessage = {
      role: "assistant",
      content: [{ type: "toolCall", toolName: "read", toolCallId: "tool-2", args: {} }],
    } as AssistantMessage;

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "message_end", message: firstToolOnlyMessage });
    emit({ type: "message_end", message: firstToolOnlyMessage });

    expect(steer).not.toHaveBeenCalled();

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "message_end", message: secondToolOnlyMessage });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(expect.stringContaining("2 consecutive tool calls"));
  });

  it("resets the tool-only streak after a messaging-tool reply without assistant text", () => {
    const steer = vi.fn(async () => undefined);
    const { emit } = createSubscribedSessionHarness({
      runId: "run",
      sessionKey: "agent:support:tool-only-threshold",
      config: {
        agents: {
          list: [
            {
              id: "support",
              tools: {
                maxConsecutiveToolOnlyTurns: 2,
              },
            },
          ],
        },
      },
      sessionExtras: { steer },
    });

    const messagingToolOnlyMessage = {
      role: "assistant",
      content: [{ type: "toolCall", toolName: "sessions_send", toolCallId: "tool-send", args: {} }],
    } as AssistantMessage;
    const toolOnlyMessage = {
      role: "assistant",
      content: [{ type: "toolCall", toolName: "read", toolCallId: "tool-read", args: {} }],
    } as AssistantMessage;

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "tool_execution_start",
      toolName: "sessions_send",
      toolCallId: "tool-send",
      args: { message: "Delivered via messaging tool" },
    });
    emit({
      type: "tool_execution_end",
      toolName: "sessions_send",
      toolCallId: "tool-send",
      isError: false,
      result: { details: { status: "ok" } },
    });
    emit({ type: "message_end", message: messagingToolOnlyMessage });

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "message_end", message: toolOnlyMessage });
    expect(steer).not.toHaveBeenCalled();

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", toolName: "read", toolCallId: "tool-read-2", args: {} }],
      } as AssistantMessage,
    });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(expect.stringContaining("2 consecutive tool calls"));
  });
});
