import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMatrixApprovalReactionTargetsForTest,
  resolveMatrixApprovalReactionTarget,
} from "../approval-reactions.js";
import { createMatrixBeeperStreamController, isBeeperHomeserver } from "./beeper-stream.js";

const sendMocks = vi.hoisted(() => ({
  editMessageMatrix: vi.fn(async () => "$edit"),
  sendSingleTextMessageMatrix: vi.fn(async () => ({
    messageId: "$target",
    primaryMessageId: "$target",
    receipt: { platformMessageIds: ["$target"] },
    roomId: "!room:beeper.com",
  })),
}));

vi.mock("./send.js", () => sendMocks);

afterEach(() => {
  clearMatrixApprovalReactionTargetsForTest();
});

describe("Matrix Beeper stream controller", () => {
  it("gates native streams to Beeper homeservers", () => {
    expect(isBeeperHomeserver("https://matrix.beeper.com")).toBe(true);
    expect(isBeeperHomeserver("https://chat.beeper-staging.com")).toBe(true);
    expect(isBeeperHomeserver("https://matrix.example.org")).toBe(false);
  });

  it("sends Beeper AI stream content and finalizes the target event", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const sendToDevice = vi.fn(async () => {});
    sendMocks.editMessageMatrix.mockClear();
    sendMocks.sendSingleTextMessageMatrix.mockClear();
    const client = {
      getDeviceId: () => "DEVICE",
      getEvent: vi.fn(async () => null),
      getUserId: vi.fn(async () => "@bot:beeper.com"),
      off: vi.fn((name: string) => listeners.delete(name)),
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
        listeners.set(name, listener);
      }),
      sendToDevice,
    };

    const controller = createMatrixBeeperStreamController({
      roomId: "!room:beeper.com",
      client: client as never,
      cfg: { channels: { matrix: { streaming: "partial" } } },
    });

    await controller.onReasoningStream({ text: "checking" });
    await controller.onReasoningEnd();
    await controller.onPartialReply({ text: "hello" });
    await controller.onApprovalEvent({
      approvalId: "approval-1",
      kind: "exec",
      phase: "requested",
      reason: "Needs shell access",
      toolCallId: "tool-1",
    });
    expect(
      resolveMatrixApprovalReactionTarget({
        roomId: "!room:beeper.com",
        eventId: "$target",
        reactionKey: "approval.allow_once",
      }),
    ).toEqual({ approvalId: "approval-1", decision: "allow-once" });

    listeners.get("to_device.event")?.({
      content: {
        device_id: "ALICEDEVICE",
        event_id: "$target",
        expiry_ms: 60_000,
        room_id: "!room:beeper.com",
      },
      event_id: "$subscribe",
      origin_server_ts: Date.now(),
      sender: "@alice:beeper.com",
      type: "com.beeper.stream.subscribe",
    });

    await controller.onPartialReply({ text: "hello world" });
    await controller.finalize({ text: "hello world" });

    const sendSingleCalls = sendMocks.sendSingleTextMessageMatrix.mock.calls as unknown[][];
    expect(sendSingleCalls[0]?.[2]).toMatchObject({
      extraContent: {
        "com.beeper.ai": {
          parts: [],
          role: "assistant",
        },
        "com.beeper.stream": {
          device_id: "DEVICE",
          type: "com.beeper.llm",
          user_id: "@bot:beeper.com",
        },
      },
    });
    expect(sendToDevice).toHaveBeenCalledWith(
      "com.beeper.stream.update",
      expect.objectContaining({
        "@alice:beeper.com": expect.objectContaining({
          ALICEDEVICE: expect.objectContaining({
            "com.beeper.llm.deltas": expect.any(Array),
          }),
        }),
      }),
    );
    const editCalls = sendMocks.editMessageMatrix.mock.calls as unknown[][];
    const finalEdit = editCalls.at(-1);
    expect(finalEdit?.slice(0, 3)).toEqual(["!room:beeper.com", "$target", "hello world"]);
    expect(finalEdit?.[3]).toMatchObject({
      extraContent: {
        "com.beeper.ai": {
          role: "assistant",
        },
        "com.beeper.stream": null,
      },
      topLevelExtraContent: {
        "com.beeper.dont_render_edited": true,
        "com.beeper.stream": null,
      },
    });
    const parts = (finalEdit?.[3] as { extraContent?: { "com.beeper.ai"?: { parts?: unknown[] } } })
      .extraContent?.["com.beeper.ai"]?.parts;
    expect(parts).toEqual(
      expect.arrayContaining([
        { state: "done", text: "checking", type: "reasoning" },
        { state: "done", text: "hello world", type: "text" },
        expect.objectContaining({
          approval: expect.objectContaining({ id: "approval-1", reason: "Needs shell access" }),
          state: "approval-requested",
          toolCallId: "tool-1",
          type: "tool-exec",
        }),
      ]),
    );
  });
});
