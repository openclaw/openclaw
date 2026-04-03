import { describe, expect, it, vi } from "vitest";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      type,
      action,
      sessionKey,
      context,
      timestamp: new Date(),
      messages: [],
    }),
  ),
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    createInternalHookEvent: internalHookMocks.createInternalHookEvent,
    triggerInternalHook: internalHookMocks.triggerInternalHook,
  };
});

import { createSignalEventHandler } from "./event-handler.js";

describe("signal mention-skip silent ingest", () => {
  it("emits internal message:received when ingest is enabled", async () => {
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            groupChat: { mentionPatterns: ["@bot"] },
          },
          channels: {
            signal: {
              groups: {
                "*": {
                  requireMention: true,
                  ingest: true,
                },
              },
            },
          },
        } as never,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello without mention",
          attachments: [],
          groupInfo: { groupId: "group-123", groupName: "Ops" },
        },
      }),
    );

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      expect.stringContaining("signal"),
      expect.objectContaining({
        channelId: "signal",
        content: "hello without mention",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });
});
