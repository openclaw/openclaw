import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement as beforeSettled } from "../../../../test/helpers/promise.js";
import { chunkText } from "../../../auto-reply/chunk.js";
import * as transcript from "../../../infra/outbound/deliver-transcript.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { deliverCompletionDirect } from "./subagent-announce-completion-delivery.js";

const content = "Long child result. ".repeat(180).trim();

afterEach(() => {
  vi.restoreAllMocks();
  setActivePluginRegistry(createTestRegistry());
});

function setup(outcome: "rejected" | "aborted" | "sent" = "sent") {
  const controller = new AbortController();
  const onDeliveryResult =
    vi.fn<NonNullable<Parameters<typeof deliverCompletionDirect>[0]["onDeliveryResult"]>>();
  const received: string[] = [];
  const sendText = vi.fn(async ({ text }: { text: string }) => {
    if (received.length > 0 && outcome !== "sent") {
      if (outcome === "aborted") {
        controller.abort(new Error("second chunk aborted"));
        controller.signal.throwIfAborted();
      }
      throw new Error("second chunk rejected");
    }
    received.push(text);
    return { channel: "discord", messageId: `chunk-${received.length}` };
  });
  const plugin = createOutboundTestPlugin({
    id: "discord",
    outbound: { deliveryMode: "direct", chunker: chunkText, textChunkLimit: 2_000, sendText },
  });
  setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));
  const deliver = () =>
    deliverCompletionDirect({
      cfg: {},
      requesterSessionKey: "agent:main:discord:dm:U123",
      directIdempotencyKey: "chunked-text-completion",
      deliveryTarget: { deliver: true, channel: "discord", to: "dm:U123" },
      internalEvents: taskCompletionEvents({ result: content }),
      contentKind: "completed_result",
      signal: controller.signal,
      onDeliveryResult,
    });
  return { deliver, received, sendText, onDeliveryResult };
}

it.each(["rejected", "aborted"] as const)("settles after chunk two is %s", async (outcome) => {
  const fixture = setup(outcome);
  const result = await fixture.deliver();

  expect(fixture.sendText).toHaveBeenCalledTimes(2);
  expect(fixture.received).toHaveLength(1);
  expect(result).toMatchObject({
    delivered: false,
    path: "direct",
    disposition: "permanent_failure",
    error: expect.stringContaining(`second chunk ${outcome}`),
  });
  expect(fixture.onDeliveryResult).not.toHaveBeenCalled();
});

it("reports complete delivery before transcript mirroring settles", async () => {
  const fixture = setup();
  const mirrorGate = createEnteredGate();
  vi.spyOn(transcript, "mirrorDeliveredPayloads").mockImplementation(mirrorGate.wait);
  const delivery = fixture.deliver();
  try {
    await beforeSettled(mirrorGate.entered, delivery, "Delivery missed its mirror");
    expect(fixture.sendText).toHaveBeenCalledTimes(2);
    expect(fixture.received.join(" ")).toBe(content);
    expect(fixture.onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ delivered: true, deliveredAt: expect.any(Number) }),
    );
  } finally {
    mirrorGate.release();
    await delivery;
  }
  await expect(delivery).resolves.toMatchObject({ delivered: true, path: "direct" });
});

it.each(["mirror", "report"] as const)("keeps delivery after %s rejects", async (failure) => {
  const fixture = setup();
  const error = new Error("post-send bookkeeping failed");
  if (failure === "mirror") {
    vi.spyOn(transcript, "mirrorDeliveredPayloads").mockRejectedValue(error);
  } else {
    fixture.onDeliveryResult.mockRejectedValue(error);
  }

  await expect(fixture.deliver()).resolves.toMatchObject({ delivered: true, path: "direct" });
  expect(fixture.received.join(" ")).toBe(content);
  expect(fixture.onDeliveryResult).toHaveBeenCalledOnce();
});
