import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkText } from "../../../auto-reply/chunk.js";
import * as transcript from "../../../infra/outbound/deliver-transcript.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { deliverCompletionDirect } from "./subagent-announce-completion-delivery.js";
import { runSubagentAnnounceDispatch } from "./subagent-announce-dispatch.js";

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
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "discord",
          outbound: {
            deliveryMode: "direct",
            chunker: chunkText,
            textChunkLimit: 2_000,
            sendText,
          },
        }),
      },
    ]),
  );
  const steer = vi.fn(async () => ({ status: "steered" as const }));
  const deliver = () =>
    runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
      steer,
      direct: async () => {
        const result = await deliverCompletionDirect({
          cfg: {},
          requesterSessionKey: "agent:main:discord:dm:U123",
          directIdempotencyKey: "chunked-text-completion",
          deliveryTarget: { deliver: true, channel: "discord", to: "dm:U123" },
          internalEvents: taskCompletionEvents({ result: content }),
          contentKind: "completed_result",
          signal: controller.signal,
          onDeliveryResult,
        });
        if (!result) {
          throw new Error("Expected a direct text completion attempt");
        }
        return result;
      },
    });
  return { deliver, received, sendText, onDeliveryResult, steer };
}

describe("direct completion text delivery", () => {
  it.each(["rejected", "aborted", "sent"] as const)(
    "settles a chunked result when its second chunk is %s",
    async (outcome) => {
      const fixture = setup(outcome);
      const result = await fixture.deliver();

      expect(fixture.sendText).toHaveBeenCalledTimes(2);
      expect(fixture.steer).not.toHaveBeenCalled();
      if (outcome === "sent") {
        expect(fixture.received.join(" ")).toBe(content);
        expect(result).toMatchObject({ delivered: true, path: "direct" });
        expect(fixture.onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ delivered: true }),
        );
      } else {
        expect(fixture.received).toHaveLength(1);
        expect(result).toMatchObject({
          delivered: false,
          path: "direct",
          disposition: "permanent_failure",
        });
        expect(result.error).toContain(`second chunk ${outcome}`);
        expect(fixture.onDeliveryResult).not.toHaveBeenCalled();
      }
    },
  );

  it("reports complete delivery before transcript mirroring settles", async () => {
    const fixture = setup();
    const mirrorEntered = createDeferredCore();
    const releaseMirror = createDeferredCore();
    vi.spyOn(transcript, "mirrorDeliveredPayloads").mockImplementation(async () => {
      mirrorEntered.resolve();
      await releaseMirror.promise;
    });
    const delivery = fixture.deliver();
    try {
      await Promise.race([
        mirrorEntered.promise,
        delivery.then(() => {
          throw new Error("Delivery settled without entering its mirror");
        }),
      ]);
      expect(fixture.received.join(" ")).toBe(content);
      expect(fixture.onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ delivered: true, deliveredAt: expect.any(Number) }),
      );
    } finally {
      releaseMirror.resolve();
      await delivery;
    }
    await expect(delivery).resolves.toMatchObject({ delivered: true });
  });

  it.each(["mirror", "report"] as const)(
    "preserves complete delivery when later %s bookkeeping rejects",
    async (failure) => {
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
      expect(fixture.steer).not.toHaveBeenCalled();
    },
  );
});
