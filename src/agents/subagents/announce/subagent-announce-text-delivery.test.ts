import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkText } from "../../../auto-reply/chunk.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../../config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { buildChannelOutboundSessionRoute } from "../../../plugin-sdk/core.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import * as transcript from "../../../sessions/confirmed-visible-message.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { deliverCompletionDirect } from "./subagent-announce-completion-delivery.js";
import { runSubagentAnnounceDispatch } from "./subagent-announce-dispatch.js";

const content = "Long child result. ".repeat(180).trim();
let nextDeliveryId = 0;

afterEach(() => {
  vi.restoreAllMocks();
  setActivePluginRegistry(createTestRegistry());
});

function setup(outcome: "rejected" | "aborted" | "sent" = "sent", cfg: OpenClawConfig = {}) {
  const deliveryId = `chunked-text-completion-${++nextDeliveryId}`;
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
          messaging: {
            resolveOutboundSessionRoute: (params) => ({
              ...buildChannelOutboundSessionRoute({
                cfg: params.cfg,
                agentId: params.agentId,
                channel: "discord",
                accountId: params.accountId,
                peer: { kind: "direct", id: "U123" },
                chatType: "direct",
                from: "U123",
                to: params.target,
                recipientSessionExact: true,
              }),
              sessionKey: "agent:main:discord:dm:U123",
            }),
          },
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
          cfg,
          requesterSessionKey: "agent:main:discord:dm:U123",
          directIdempotencyKey: deliveryId,
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
  it("writes a direct child completion once to the destination conversation", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const scope = {
        agentId: "main",
        storePath: state.path("sessions.json"),
        sessionKey: "agent:main:discord:dm:U123",
        sessionId: "requester-session",
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const fixture = setup("sent", {
        agents: { entries: { main: {} } },
        session: { store: scope.storePath },
      });
      await expect(fixture.deliver()).resolves.toMatchObject({ delivered: true, path: "direct" });
      const messages = (await loadTranscriptEvents(scope))
        .map(readTranscriptEventMessage)
        .filter((message) => message?.role === "assistant");
      expect(messages).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: content }],
          provider: "openclaw",
          model: "automation-result",
        }),
      ]);
    });
  });

  it.each(["rejected", "aborted"] as const)(
    "settles a chunked result when its second chunk is %s",
    async (outcome) => {
      const fixture = setup(outcome);
      const result = await fixture.deliver();

      expect(fixture.sendText).toHaveBeenCalledTimes(2);
      expect(fixture.steer).not.toHaveBeenCalled();
      expect(fixture.received).toHaveLength(1);
      expect(result).toMatchObject({
        delivered: false,
        path: "direct",
        disposition: "permanent_failure",
      });
      expect(result.error).toContain(`second chunk ${outcome}`);
      expect(fixture.onDeliveryResult).not.toHaveBeenCalled();
    },
  );

  it("reports complete delivery before destination conversation publication settles", async () => {
    const fixture = setup();
    const publicationEntered = createDeferredCore();
    const releasePublication = createDeferredCore();
    vi.spyOn(transcript, "commitConfirmedVisibleMessage").mockImplementation(async () => {
      publicationEntered.resolve();
      await releasePublication.promise;
      return { ok: true };
    });
    const delivery = fixture.deliver();
    try {
      await Promise.race([
        publicationEntered.promise,
        delivery.then(() => {
          throw new Error("Delivery settled without publishing its destination conversation");
        }),
      ]);
      expect(fixture.sendText).toHaveBeenCalledTimes(2);
      expect(fixture.steer).not.toHaveBeenCalled();
      expect(fixture.received.join(" ")).toBe(content);
      expect(fixture.onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ delivered: true, deliveredAt: expect.any(Number) }),
      );
    } finally {
      releasePublication.resolve();
      await delivery;
    }
    await expect(delivery).resolves.toMatchObject({ delivered: true, path: "direct" });
  });

  it.each(["publication", "report"] as const)(
    "preserves complete delivery when later %s bookkeeping rejects",
    async (failure) => {
      const fixture = setup();
      const error = new Error("post-send bookkeeping failed");
      vi.spyOn(transcript, "commitConfirmedVisibleMessage").mockImplementation(async () => {
        if (failure === "publication") {
          throw error;
        }
        return { ok: true };
      });
      if (failure === "report") {
        fixture.onDeliveryResult.mockRejectedValue(error);
      }

      await expect(fixture.deliver()).resolves.toMatchObject({ delivered: true, path: "direct" });
      expect(fixture.received.join(" ")).toBe(content);
      expect(fixture.onDeliveryResult).toHaveBeenCalledOnce();
      expect(fixture.steer).not.toHaveBeenCalled();
    },
  );
});
