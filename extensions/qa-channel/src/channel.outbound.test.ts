import path from "node:path";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import { qaChannelPlugin, setQaChannelRuntime } from "../api.js";

const QA_GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0nQAAAAASUVORK5CYII=";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function createQaChannelConfig(params: {
  baseUrl: string;
  allowFrom?: string[];
  mediaMaxMb?: number;
}) {
  return {
    channels: {
      "qa-channel": {
        baseUrl: params.baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: params.allowFrom,
        mediaMaxMb: params.mediaMaxMb,
      },
    },
  };
}

function requireQaMessageAdapter() {
  const adapter = qaChannelPlugin.message;
  if (!adapter) {
    throw new Error("expected qa-channel message adapter");
  }
  return adapter;
}

function requireQaLegacyOutbound() {
  const outbound = qaChannelPlugin.outbound;
  if (!outbound?.sendText || !outbound.sendMedia) {
    throw new Error("expected qa-channel legacy outbound adapter");
  }
  return {
    sendText: outbound.sendText,
    sendMedia: outbound.sendMedia,
  };
}

async function startQaChannelTestHarness(params?: { allowFrom?: string[]; mediaMaxMb?: number }) {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
  const state = createQaBusState();
  const bus = await startQaBusServer({ state });
  setQaChannelRuntime(createPluginRuntimeMock());
  const cfg = createQaChannelConfig({
    baseUrl: bus.baseUrl,
    allowFrom: params?.allowFrom,
    mediaMaxMb: params?.mediaMaxMb,
  });
  const account = qaChannelPlugin.config.resolveAccount(cfg, "default");
  const abort = new AbortController();
  const startAccount = qaChannelPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("expected qa-channel gateway startAccount");
  }
  const task = startAccount(
    createStartAccountContext({
      account,
      cfg,
      abortSignal: abort.signal,
    }),
  );
  return {
    state,
    baseUrl: bus.baseUrl,
    async stop() {
      abort.abort();
      await task;
      await bus.stop();
    },
  };
}

describe("qa-channel outbound delivery", () => {
  it("backs declared message adapter capabilities with qa bus sends", async () => {
    const harness = await startQaChannelTestHarness({ allowFrom: ["*"] });
    try {
      const adapter = requireQaMessageAdapter();

      const proveText = async () => {
        const result = await adapter.send!.text!({
          cfg: createQaChannelConfig({ baseUrl: harness.baseUrl, allowFrom: ["*"] }),
          to: "thread:qa-room/thread-1",
          text: "hello",
          accountId: "default",
          replyToId: "parent-1",
        });
        const receiptPart = result.receipt.parts[0];
        expect(receiptPart?.kind).toBe("text");
        expect(receiptPart?.replyToId).toBe("parent-1");
        expect(receiptPart?.threadId).toBe("thread-1");
      };
      const proveMedia = async (kind: "media" | "payload" = "media") => {
        const mediaPath = path.join(process.cwd(), "qa-channel-generated-capability.png");
        const context = {
          cfg: createQaChannelConfig({ baseUrl: harness.baseUrl, allowFrom: ["*"] }),
          to: "thread:qa-room/thread-1",
          text: "generated image",
          mediaUrl: mediaPath,
          mediaLocalRoots: [process.cwd()],
          mediaReadFile: async (filePath: string) => {
            expect(filePath).toBe(mediaPath);
            return Buffer.from(QA_GENERATED_IMAGE_BASE64, "base64");
          },
          accountId: "default",
          replyToId: "parent-1",
        };
        const result =
          kind === "payload"
            ? await adapter.send!.payload!({
                ...context,
                payload: {
                  text: context.text,
                  mediaUrl: mediaPath,
                  mediaUrls: [mediaPath],
                  isError: true,
                },
              })
            : await adapter.send!.media!(context);
        expect(result.receipt.parts[0]).toMatchObject({
          kind: "media",
          replyToId: "parent-1",
          threadId: "thread-1",
        });
        if (kind === "payload") {
          expect(harness.state.getSnapshot().messages.at(-1)?.isError).toBe(true);
        }
      };

      await verifyChannelMessageAdapterCapabilityProofs({
        adapterName: "qaChannelMessageAdapter",
        adapter,
        proofs: {
          text: proveText,
          media: proveMedia,
          payload: () => proveMedia("payload"),
          replyTo: proveText,
          thread: proveText,
          messageSendingHooks: () => {
            expect(adapter.send!.text).toBeTypeOf("function");
          },
        },
      });
    } finally {
      await harness.stop();
    }
  });

  it("forwards dispatch and cancellation authority to the QA bus boundary", async () => {
    const harness = await startQaChannelTestHarness({ allowFrom: ["*"] });
    const order: string[] = [];
    const abort = new AbortController();
    try {
      const adapter = requireQaMessageAdapter();
      await adapter.send!.text!({
        cfg: createQaChannelConfig({ baseUrl: harness.baseUrl, allowFrom: ["*"] }),
        to: "dm:alice",
        text: "bounded delivery",
        accountId: "default",
        signal: abort.signal,
        onPlatformSendDispatch: async () => {
          order.push("dispatch");
        },
        assertDirectAdapterHandoff: () => {
          order.push("fence");
        },
      });

      expect(order).toEqual(["dispatch", "fence"]);
      expect(harness.state.getSnapshot().messages).toEqual([
        expect.objectContaining({
          direction: "outbound",
          text: "bounded delivery",
          conversation: expect.objectContaining({ id: "alice" }),
        }),
      ]);
    } finally {
      abort.abort();
      await harness.stop();
    }
  });

  it.each(["text", "media"] as const)(
    "forwards legacy %s delivery authority to the physical QA request",
    async (kind) => {
      const harness = await startQaChannelTestHarness({ allowFrom: ["*"] });
      const order: string[] = [];
      const abort = new AbortController();
      try {
        const outbound = requireQaLegacyOutbound();
        const common = {
          cfg: createQaChannelConfig({ baseUrl: harness.baseUrl, allowFrom: ["*"] }),
          to: "dm:alice",
          text: `legacy ${kind}`,
          accountId: "default",
          signal: abort.signal,
          onPlatformSendDispatch: async () => {
            order.push("dispatch");
          },
          assertDirectAdapterHandoff: () => {
            order.push("fence");
          },
        };
        if (kind === "text") {
          await outbound.sendText(common);
        } else {
          await outbound.sendMedia({
            ...common,
            mediaUrl: path.join(process.cwd(), "qa-channel-legacy-image.png"),
            mediaLocalRoots: [process.cwd()],
            mediaReadFile: async () => Buffer.from(QA_GENERATED_IMAGE_BASE64, "base64"),
          });
        }

        expect(order).toEqual(["dispatch", "fence"]);
        expect(harness.state.getSnapshot().messages).toEqual([
          expect.objectContaining({
            direction: "outbound",
            text: `legacy ${kind}`,
            ...(kind === "media"
              ? { attachments: [expect.objectContaining({ kind: "image" })] }
              : {}),
          }),
        ]);
      } finally {
        abort.abort();
        await harness.stop();
      }
    },
  );

  it("cancels legacy media preparation before any QA request", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    const preparationStarted = createDeferred<void>();
    const releasePreparation = createDeferred<void>();
    const abort = new AbortController();
    const onPlatformSendDispatch = vi.fn(async () => {});
    const assertDirectAdapterHandoff = vi.fn();
    try {
      const pending = requireQaLegacyOutbound().sendMedia({
        cfg: createQaChannelConfig({ baseUrl: bus.baseUrl }),
        to: "dm:alice",
        text: "must not escape",
        mediaUrl: path.join(process.cwd(), "qa-channel-held-image.png"),
        mediaLocalRoots: [process.cwd()],
        mediaReadFile: async () => {
          preparationStarted.resolve();
          await releasePreparation.promise;
          return Buffer.from(QA_GENERATED_IMAGE_BASE64, "base64");
        },
        signal: abort.signal,
        onPlatformSendDispatch,
        assertDirectAdapterHandoff,
      });
      await preparationStarted.promise;
      abort.abort(new Error("current turn closed"));

      const error = await pending.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(error).toMatchObject({ retryable: false });
      expect(error).not.toHaveProperty("sentBeforeError");
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
      expect(assertDirectAdapterHandoff).not.toHaveBeenCalled();
      expect(state.getSnapshot().messages).toEqual([]);
    } finally {
      releasePreparation.resolve();
      await bus.stop();
    }
  });

  it("delivers a generated image and caption in exactly one physical QA message", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    try {
      const mediaPath = path.join(process.cwd(), "qa-channel-generated-image.png");
      const result = await requireQaMessageAdapter().send!.payload!({
        cfg: createQaChannelConfig({ baseUrl: bus.baseUrl }),
        to: "thread:qa-room/thread-1",
        text: "Here is your generated image.",
        mediaUrl: mediaPath,
        mediaLocalRoots: [process.cwd()],
        mediaReadFile: async () => Buffer.from(QA_GENERATED_IMAGE_BASE64, "base64"),
        accountId: "default",
        replyToId: "parent-1",
        threadId: "thread-1",
        payload: {
          text: "Here is your generated image.",
          mediaUrl: mediaPath,
          mediaUrls: [mediaPath],
        },
      });
      const outbound = state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound");
      expect(qaChannelPlugin.capabilities.media).toBe(true);
      expect(outbound).toHaveLength(1);
      expect(outbound[0]).toMatchObject({
        id: result.messageId,
        text: "Here is your generated image.",
        threadId: "thread-1",
        replyToId: "parent-1",
        attachments: [
          {
            kind: "image",
            mimeType: "image/png",
            fileName: "qa-channel-generated-image.png",
            contentBase64: QA_GENERATED_IMAGE_BASE64,
          },
        ],
      });
      expect(result.receipt.parts[0]?.kind).toBe("media");
    } finally {
      await bus.stop();
    }
  });
});
