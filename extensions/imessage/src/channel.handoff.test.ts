import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIMessageOutboundRpcFixture } from "./test-support/outbound-rpc.test-support.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

describe("iMessage registered send authority", () => {
  let state: OpenClawTestState;
  let fixture: ReturnType<typeof createIMessageOutboundRpcFixture>;
  let imessagePlugin: (typeof import("./channel.js"))["imessagePlugin"];

  beforeEach(async () => {
    state = await createOpenClawTestState({ layout: "state-only", prefix: "imessage-handoff-" });
    await loadFreshIMessageReplyCacheForTest();
    const { sendMessageIMessage } = await import("./send.js");
    ({ imessagePlugin } = await import("./channel.js"));
    fixture = createIMessageOutboundRpcFixture(state, sendMessageIMessage);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it.each(["message", "outbound"] as const)(
    "stops %s media delivery when the caller retires during the actual attachment read",
    async (registration) => {
      const send =
        registration === "message"
          ? imessagePlugin.message?.send?.media
          : imessagePlugin.outbound?.sendMedia;
      if (!send) {
        throw new Error(`Missing registered ${registration} media sender`);
      }
      const mediaUrl = state.path("report.pdf");
      const bytes = Buffer.from("%PDF-1.7\nsynthetic attachment\n");
      fs.writeFileSync(mediaUrl, bytes);
      const reading = createDeferred<void>();
      const releaseRead = createDeferred<Buffer>();
      let current = true;
      const retired = new Error("iMessage caller retired");
      const onPlatformSendDispatch = vi.fn(async () => {});
      const delivery = send({
        cfg: fixture.cfg,
        to: "chat_guid:iMessage;+;chat0000",
        text: "",
        mediaUrl,
        mediaAccess: {
          localRoots: [path.dirname(mediaUrl)],
          readFile: async () => {
            reading.resolve();
            return await releaseRead.promise;
          },
        },
        assertDirectAdapterHandoff: () => {
          if (!current) {
            throw retired;
          }
        },
        onPlatformSendDispatch,
      });
      const settled = delivery.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(
          await Promise.race([reading.promise.then(() => true), settled.then(() => false)]),
        ).toBe(true);
        current = false;
      } finally {
        releaseRead.resolve(bytes);
        await settled;
      }
      expect(await settled).toEqual({ error: retired });
      expect(fixture.readActions()).toEqual([]);
      expect(fixture.readRequests()).toEqual([]);
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["message", "outbound"] as const)(
    "preserves ordinary %s text delivery and native dispatch evidence",
    async (registration) => {
      const send =
        registration === "message"
          ? imessagePlugin.message?.send?.text
          : imessagePlugin.outbound?.sendText;
      if (!send) {
        throw new Error(`Missing registered ${registration} text sender`);
      }
      const onPlatformSendDispatch = vi.fn(async () => {
        expect(fixture.readRequests()).toEqual([]);
      });
      const result = await send({
        cfg: fixture.cfg,
        to: "chat_guid:iMessage;+;chat0000",
        text: "active delivery",
        assertDirectAdapterHandoff: () => {},
        onPlatformSendDispatch,
      });
      expect(result.receipt?.platformMessageIds).toEqual(["p:0/imsg-rpc-proof"]);
      expect(fixture.readRequests()).toMatchObject([
        { method: "send", params: { text: "active delivery", chat_guid: "iMessage;+;chat0000" } },
      ]);
      expect(fixture.readActions()).toEqual([]);
      expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    },
  );

  it.each(["message", "outbound"] as const)(
    "rechecks %s text authority after the dispatch callback waits",
    async (registration) => {
      const send =
        registration === "message"
          ? imessagePlugin.message?.send?.text
          : imessagePlugin.outbound?.sendText;
      if (!send) {
        throw new Error(`Missing registered ${registration} text sender`);
      }
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const retired = new Error("iMessage caller retired during dispatch refresh");
      let current = true;
      const settled = send({
        cfg: fixture.cfg,
        to: "chat_guid:iMessage;+;chat0000",
        text: "obsolete delivery",
        assertDirectAdapterHandoff: () => {
          if (!current) {
            throw retired;
          }
        },
        onPlatformSendDispatch: async () => {
          entered.resolve();
          await release.promise;
        },
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(
          await Promise.race([entered.promise.then(() => true), settled.then(() => false)]),
        ).toBe(true);
        current = false;
      } finally {
        release.resolve();
        await settled;
      }
      expect(await settled).toEqual({ error: retired });
      expect(fixture.readRequests()).toEqual([]);
    },
  );

  it.each(["message", "outbound"] as const)(
    "retains %s attachment acceptance when retirement stops its later caption",
    async (registration) => {
      const send =
        registration === "message"
          ? imessagePlugin.message?.send?.media
          : imessagePlugin.outbound?.sendMedia;
      if (!send) {
        throw new Error(`Missing registered ${registration} media sender`);
      }
      const mediaUrl = state.path("captioned.pdf");
      fs.writeFileSync(mediaUrl, Buffer.from("%PDF-1.7\nsynthetic attachment\n"));
      const accepted = createDeferred<void>();
      const release = createDeferred<void>();
      const retired = new Error("iMessage caller retired after accepted attachment");
      let current = true;
      const onPlatformSendDispatch = vi.fn(async () => {});
      const onDeliveryResult = vi.fn(async () => {
        accepted.resolve();
        await release.promise;
      });
      const settled = send({
        cfg: fixture.cfg,
        to: "chat_guid:iMessage;+;chat0000",
        text: "caption must not be sent",
        mediaUrl,
        mediaLocalRoots: [path.dirname(mediaUrl)],
        assertDirectAdapterHandoff: () => {
          if (!current) {
            throw retired;
          }
        },
        onPlatformSendDispatch,
        onDeliveryResult,
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(
          await Promise.race([accepted.promise.then(() => true), settled.then(() => false)]),
        ).toBe(true);
        current = false;
      } finally {
        release.resolve();
        await settled;
      }
      expect(await settled).toMatchObject({
        error: {
          code: "CHANNEL_PARTIAL_DELIVERY",
          cause: retired,
          sentBeforeError: true,
          deliveryResult: {
            messageIds: ["p:0/imsg-action-proof"],
            content: "",
            visibleReplySent: true,
          },
        },
      });
      expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          receipt: expect.objectContaining({ platformMessageIds: ["p:0/imsg-action-proof"] }),
        }),
      );
      expect(fixture.readActions()).toHaveLength(1);
      expect(fixture.readActions()[0]?.[0]).toBe("send-attachment");
      expect(fixture.readRequests()).toEqual([]);
      expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    },
  );
});
