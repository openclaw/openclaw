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
  let caller: AbortController;
  const retired = new Error("iMessage caller retired");
  const onPlatformSendDispatch = vi.fn(async () => {});
  const bytes = Buffer.from("%PDF-1.7\nsynthetic attachment\n");

  function sendContext() {
    return {
      cfg: fixture.cfg,
      to: "chat_guid:iMessage;+;chat0000",
      assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      onPlatformSendDispatch,
    };
  }

  async function retireDuring<T>(
    delivery: Promise<T>,
    entered: Promise<unknown>,
    release: () => void,
  ) {
    const settled = delivery.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(await Promise.race([entered.then(() => true), settled.then(() => false)])).toBe(true);
      caller.abort(retired);
    } finally {
      release();
      await settled;
    }
    return await settled;
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({ layout: "state-only", prefix: "imessage-handoff-" });
    await loadFreshIMessageReplyCacheForTest();
    const { sendMessageIMessage } = await import("./send.js");
    ({ imessagePlugin } = await import("./channel.js"));
    fixture = createIMessageOutboundRpcFixture(state, sendMessageIMessage);
    caller = new AbortController();
    onPlatformSendDispatch.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it("stops message media delivery when the caller retires during the actual attachment read", async () => {
    const send = imessagePlugin.message?.send?.media;
    if (!send) {
      throw new Error("Missing registered message media sender");
    }
    const mediaUrl = state.path("report.pdf");
    fs.writeFileSync(mediaUrl, bytes);
    const reading = createDeferred<void>();
    const releaseRead = createDeferred<Buffer>();
    const result = await retireDuring(
      send({
        ...sendContext(),
        text: "",
        mediaUrl,
        mediaAccess: {
          localRoots: [path.dirname(mediaUrl)],
          readFile: async () => {
            reading.resolve();
            return await releaseRead.promise;
          },
        },
      }),
      reading.promise,
      () => releaseRead.resolve(bytes),
    );
    expect(result).toEqual({ error: retired });
    expect(fixture.readActions()).toEqual([]);
    expect(fixture.readRequests()).toEqual([]);
    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
  });

  it("preserves ordinary message text delivery and native dispatch evidence", async () => {
    const send = imessagePlugin.message?.send?.text;
    if (!send) {
      throw new Error("Missing registered message text sender");
    }
    onPlatformSendDispatch.mockImplementation(async () => {
      expect(fixture.readRequests()).toEqual([]);
    });
    const result = await send({ ...sendContext(), text: "active delivery" });
    expect(result.receipt?.platformMessageIds).toEqual(["p:0/imsg-rpc-proof"]);
    expect(fixture.readRequests()).toMatchObject([
      { method: "send", params: { text: "active delivery", chat_guid: "iMessage;+;chat0000" } },
    ]);
    expect(fixture.readActions()).toEqual([]);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("rechecks outbound text authority after the dispatch callback waits", async () => {
    const send = imessagePlugin.outbound?.sendText;
    if (!send) {
      throw new Error("Missing registered outbound text sender");
    }
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const result = await retireDuring(
      send({
        ...sendContext(),
        text: "obsolete delivery",
        onPlatformSendDispatch: async () => {
          entered.resolve();
          await release.promise;
        },
      }),
      entered.promise,
      () => release.resolve(),
    );
    expect(result).toEqual({ error: retired });
    expect(fixture.readRequests()).toEqual([]);
  });

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
      fs.writeFileSync(mediaUrl, bytes);
      const accepted = createDeferred<void>();
      const release = createDeferred<void>();
      const onDeliveryResult = vi.fn(async () => {
        accepted.resolve();
        await release.promise;
      });
      const result = await retireDuring<Awaited<ReturnType<typeof send>>>(
        send({
          ...sendContext(),
          text: "caption must not be sent",
          mediaUrl,
          mediaLocalRoots: [path.dirname(mediaUrl)],
          onDeliveryResult,
        }),
        accepted.promise,
        () => release.resolve(),
      );
      expect(result).toMatchObject({
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
