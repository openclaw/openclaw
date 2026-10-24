// Thread-isolation context assertions for the Matrix monitor handler (#176224).
// Registered from handler.test.ts to reuse its mocked monitor runtime graph.
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixTextMessageEvent as textEvent,
} from "./handler.test-helpers.js";

const requireRecord = createRequireRecord("object", "expected-label");

function mockCalls(mock: unknown, label: string): unknown[][] {
  if (!vi.isMockFunction(mock)) {
    throw new Error(`${label} was not a mock`);
  }
  return mock.mock.calls;
}

function callArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  return expectDefined(mockCalls(mock, label).at(callIndex), label)[argIndex];
}

function recordArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  return requireRecord(callArg(mock, callIndex, argIndex, label), label);
}

function receiveText(
  handler: ReturnType<typeof createHarness>["handler"],
  event: Parameters<typeof textEvent>[0],
  roomId: string,
) {
  return handler(roomId, textEvent(event));
}

function threadRoot(eventId = "$root", body = "Root topic") {
  return textEvent({ eventId, sender: "@alice:example.org", body });
}

function threadRelation(root = "$root") {
  return { rel_type: "m.thread", event_id: root, "m.in_reply_to": { event_id: root } };
}

export function registerMatrixThreadIsolationTests() {
  it("records room thread context with isolated session and recovery parent", async () => {
    const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
      eventId === "$root"
        ? threadRoot("$root", "Root topic")
        : textEvent({ eventId, sender: "@bot:example.org", body: "" }),
    );
    const { handler, finalizeInboundContext, recordInboundSession } = createHarness({
      client: { getEvent },
      getMemberDisplayName: async (_roomId, userId) =>
        userId === "@alice:example.org" ? "Alice" : "sender",
    });
    await receiveText(
      handler,
      {
        eventId: "$reply1",
        body: "@room follow up",
        mentions: { room: true },
        relatesTo: threadRelation("$root"),
      },
      "!room:example.org",
    );
    const context = recordArg(finalizeInboundContext, 0, 0, "finalized context");
    expect(context.ThreadStarterBody).toBe("Matrix thread root $root from Alice:\nRoot topic");
    expect(context.MessageThreadId).toBe("$root");
    // Thread sessions start isolated: no room transcript fork request (#176224).
    expect(context.ParentSessionKey).toBeUndefined();
    // Model overrides stay descriptive via the model parent key; the explicit
    // recovery parent key authorizes restart-recovery replacement without
    // requesting a transcript fork on ordinary starts.
    expect(context.ModelParentSessionKey).toBe("agent:ops:main");
    expect(context.RecoveryParentSessionKey).toBe("agent:ops:main");
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:ops:main:thread:$root" }),
    );
  });
}
