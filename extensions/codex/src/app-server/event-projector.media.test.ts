import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  installCodexToolResultMiddleware,
  resetOpenClawOwnedToolHooks,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RemoteWorkspaceFileReader } from "openclaw/plugin-sdk/file-access-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { Type } from "typebox";
import { afterEach, beforeEach } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  createConfiguredProjection,
  createProjection,
} from "./event-projector-projection.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  tinyPngBase64,
  fs,
  path,
  createParams,
  requireRecord,
  forCurrentTurn,
} from "./event-projector.test-harness.js";
import {
  CodexGeneratedMediaToolBinding,
  createCodexGeneratedMediaTool,
} from "./generated-media-tool.js";
import type { JsonObject } from "./protocol.js";

registerCodexEventProjectorTestLifecycle();

const SECOND_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

type Events = Awaited<ReturnType<typeof createProjection>>["events"];
const codexImages = "/home/dev-user/.codex/generated_images/session-1";
function nativeImage(id: string, result?: string, savedPath?: string) {
  return {
    type: "imageGeneration" as const,
    id,
    status: "completed" as const,
    ...(result === undefined ? {} : { result }),
    ...(savedPath ? { savedPath } : {}),
  };
}
function codexImage(id: string) {
  return nativeImage(id, tinyPngBase64, `${codexImages}/${id}.png`);
}
function readImages(urls: string[] = []) {
  return Promise.all(
    urls.map(async (url) => ({ url, base64: (await fs.readFile(url)).toString("base64") })),
  );
}
function rawImage(id: string, result = tinyPngBase64) {
  return { type: "image_generation_call", id, status: "completed", result };
}
function assistantEvent(id: string, text: string, raw = false) {
  return forCurrentTurn(raw ? "rawResponseItem/completed" : "item/completed", {
    item: raw
      ? { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] }
      : { type: "agentMessage", id, text },
  });
}
function expectUndeliverableImage(events: Events) {
  const result = events.result();
  expect(result.toolMediaUrls).toBeUndefined();
  expect(result.hostOwnedToolMediaUrls).toBeUndefined();
  expect(result.replayMetadata).toStrictEqual({ hadPotentialSideEffects: true, replaySafe: false });
}
async function expectImage(events: Events) {
  const result = events.result();
  expect(result.toolMediaUrls).toHaveLength(1);
  expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
  const mediaUrl = result.toolMediaUrls?.[0] ?? "";
  await expect(fs.readFile(mediaUrl)).resolves.toEqual(Buffer.from(tinyPngBase64, "base64"));
  return mediaUrl;
}
function createMessageBridge(
  send: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
  tools: AnyAgentTool[] = [],
) {
  const execute = vi.fn(send);
  const bridge = createCodexDynamicToolBridge({
    tools: [
      ...tools,
      {
        name: "message",
        label: "Message",
        description: "Send a synthetic attachment",
        parameters: Type.Object({}, { additionalProperties: true }),
        execute: async (_callId, args) => execute(requireRecord(args, "message arguments")),
      },
    ],
    signal: new AbortController().signal,
    hookContext,
  });
  return { bridge, execute };
}
function sendMedia(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  mediaUrl: string,
  target?: string,
) {
  return bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "send-media",
    namespace: null,
    tool: "message",
    arguments: {
      action: "send",
      mediaUrl,
      ...(target
        ? { provider: "telegram", to: target }
        : { message: "Original source reply arguments" }),
    },
  });
}
function receipt(partialDelivery = false) {
  return { status: "settled", partialDelivery, createdThreadIds: [] };
}
function messageResult(details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: "Sent." }], details };
}
function internalReply(mediaUrl: unknown) {
  return {
    deliveryStatus: "sent",
    sourceReplySink: "internal-ui",
    sourceReply: { text: "Attached.", mediaUrls: [mediaUrl] },
  };
}

async function createRemoteGeneratedMediaDelivery(
  send: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>,
) {
  const params = await createParams();
  const remoteWorkspaceRoot = "/remote/codex-workspace";
  const sources = {
    first: `${remoteWorkspaceRoot}/generated/first.png`,
    second: `${remoteWorkspaceRoot}/generated/second.png`,
  };
  const { events } = await createProjection(params, { remoteWorkspaceRoot });
  for (const [id, savedPath, result] of [
    ["generated-first", sources.first, tinyPngBase64],
    ["generated-second", sources.second, SECOND_PNG_BASE64],
  ] as const) {
    await events.completed(nativeImage(id, result, savedPath));
  }
  const { bridge, execute } = createMessageBridge(send, {
    workspaceDir: params.workspaceDir,
    remoteWorkspaceRoot,
  });
  bridge.setRemoteWorkspaceFileReader?.(async ({ path: source }) => {
    if (source !== sources.first) {
      throw new Error(`Unexpected synthetic media source: ${source}`);
    }
    return Buffer.from(tinyPngBase64, "base64");
  });
  return { events, bridge, execute, sources };
}

let openClawState: OpenClawTestState;
beforeEach(async () => {
  openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-codex-media-state-",
  });
});
afterEach(async () => {
  resetOpenClawOwnedToolHooks();
  await openClawState.cleanup();
});

describe("CodexAppServerEventProjector media projection", () => {
  it.each(["unsent", "source-reply", "failed", "other-destination"])(
    "discards only an explicitly rejected candidate with a %s keeper",
    async (delivery) => {
      const { projector, events } = await createProjection();
      await events.completed(nativeImage("rejected", tinyPngBase64));
      await events.completed(nativeImage("keeper", SECOND_PNG_BASE64));
      const binding = new CodexGeneratedMediaToolBinding();
      binding.current = projector.generatedMediaProjection;
      const tool = createCodexGeneratedMediaTool({
        toolBindings: { codexGeneratedMedia: binding },
        assertInvocationCurrent() {},
      });
      if (!tool) {
        throw new Error("Expected the Codex generated-media tool");
      }
      const { bridge } = createMessageBridge(
        async (args) => {
          if (delivery === "failed") {
            throw new Error("Synthetic send failure");
          }
          return messageResult({
            ...(delivery === "source-reply" ? internalReply(args.mediaUrl) : {}),
            messageDelivery: {
              ...receipt(),
              ...(delivery === "source-reply" ? { sourceReplyDelivered: true } : {}),
            },
          });
        },
        undefined,
        [tool],
      );
      const invoke = (args: JsonObject) =>
        bridge.handleToolCall({
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "candidate-selection",
          namespace: null,
          tool: "generated_media",
          arguments: args,
        });
      const listed = await invoke({ action: "list" });
      expect(listed.success).toBe(true);
      const [listing] = listed.contentItems;
      if (listing?.type !== "inputText" || typeof listing.text !== "string") {
        throw new Error("Expected generated-media listing");
      }
      const inventory = requireRecord(JSON.parse(listing.text), "generated-media listing");
      if (!Array.isArray(inventory.images)) {
        throw new Error("Expected generated images");
      }
      const images = inventory.images.map((image) => requireRecord(image, "generated image"));
      expect(images.map((image) => image.itemId)).toEqual(["rejected", "keeper"]);
      const rejected = requireRecord(images[0], "rejected candidate");
      const keeper = requireRecord(images[1], "keeper candidate");
      if (
        typeof rejected.itemId !== "string" ||
        typeof rejected.mediaUrl !== "string" ||
        typeof keeper.mediaUrl !== "string"
      ) {
        throw new Error("Expected materialized candidate paths");
      }
      const discarded = await invoke({ action: "discard", itemIds: [rejected.itemId] });
      expect(discarded.success).toBe(true);
      if (delivery !== "unsent") {
        await sendMedia(
          bridge,
          keeper.mediaUrl,
          delivery === "other-destination" ? "elsewhere" : undefined,
        );
      }
      await events.complete();
      const result = events.result(bridge.telemetry);
      const remaining = await readImages(result.toolMediaUrls);
      expect(remaining.map((image) => image.base64)).toEqual(
        delivery === "source-reply" ? [] : [SECOND_PNG_BASE64],
      );
      expect(result.replayMetadata).toStrictEqual({
        hadPotentialSideEffects: true,
        replaySafe: false,
      });
      await expect(fs.readFile(rejected.mediaUrl)).resolves.toEqual(
        Buffer.from(tinyPngBase64, "base64"),
      );
      if (delivery === "other-destination") {
        expect(result.messagingToolSentTargets).toEqual([
          expect.objectContaining({
            to: "elsewhere",
            mediaUrls: expect.arrayContaining([keeper.mediaUrl]),
          }),
        ]);
      }
    },
  );

  it("rejects unknown discard IDs atomically and preserves discard across duplicate image events", async () => {
    const { projector, events } = await createProjection();
    await events.completed(codexImage("first"));
    const media = projector.generatedMediaProjection;
    expect(() => media.discard(["first", "future"])).toThrow("Unknown generated image item IDs");
    expect(media.list()).toEqual([expect.objectContaining({ itemId: "first", discarded: false })]);
    media.discard(["first"]);
    media.discard(["first"]);
    await events.raw(rawImage("first"));
    await events.completed(codexImage("first"));
    await events.completed(nativeImage("future", SECOND_PNG_BASE64));
    await events.complete();
    expect((await readImages(events.result().toolMediaUrls)).map((image) => image.base64)).toEqual([
      SECOND_PNG_BASE64,
    ]);
  });

  it("fences direct tool-result callbacks after blocked media when projection closes", async () => {
    const media = createDeferred<Buffer>();
    const readRemoteWorkspaceFile = vi.fn<RemoteWorkspaceFileReader>(() => media.promise);
    const onToolResult = vi.fn();
    const { projector, events } = await createConfiguredProjection(
      { verboseLevel: "full", onToolResult },
      { remoteWorkspaceRoot: "/remote/workspace", readRemoteWorkspaceFile },
    );
    const pending = events.complete([
      nativeImage("blocked-image", "", "/remote/workspace/image.png"),
      createNativeCommandItem({
        id: "command-after-image",
        aggregatedOutput: "late-output",
      }),
    ]);
    try {
      await vi.waitFor(() => expect(readRemoteWorkspaceFile).toHaveBeenCalledOnce());
      const signal = readRemoteWorkspaceFile.mock.calls[0]?.[0].signal;
      expect(signal?.aborted === true).toBe(false);
      expect(onToolResult).not.toHaveBeenCalled();
      await projector.closeProjection();
      expect(signal?.aborted).toBe(true);
      media.resolve(Buffer.from(tinyPngBase64, "base64"));
      await pending;
      expect(onToolResult).not.toHaveBeenCalled();
    } finally {
      media.resolve(Buffer.from(tinyPngBase64, "base64"));
      await pending;
    }
  });

  it.each(["unavailable", "failed"])(
    "preserves image side effects without leaking remote paths when transfer is %s",
    async (transfer) => {
      const readRemoteWorkspaceFile = vi.fn(async () => {
        throw new Error("remote generated image is unavailable");
      });
      const { events } = await createProjection(undefined, {
        remoteWorkspaceRoot: "/remote/codex-workspace",
        ...(transfer === "failed" ? { readRemoteWorkspaceFile } : {}),
      });

      await events.completed(
        nativeImage(
          "remote-image",
          undefined,
          "/remote/codex-home/generated_images/session-1/image.png",
        ),
      );

      expect(readRemoteWorkspaceFile).toHaveBeenCalledTimes(transfer === "failed" ? 1 : 0);
      expectUndeliverableImage(events);
    },
  );

  it("does not let delayed raw completion consume a newer assistant echo", async () => {
    const { projector, events } = await createProjection();
    await projector.handleNotification(assistantEvent("answer-a", "rewritten A"));
    const rawAnswerA = projector.handleNotification(assistantEvent("answer-a", "original A", true));
    await projector.handleNotification(assistantEvent("answer-b", "rewritten B"));
    await rawAnswerA;
    await projector.handleNotification(assistantEvent("answer-b", "original B", true));
    await events.complete();

    const result = events.result();
    expect(result.assistantTexts).toEqual(["rewritten B"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "rewritten B" }]);
  });

  it("rejects oversized typed Codex images instead of using a remote saved path", async () => {
    const { events } = await createConfiguredProjection({
      config: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    });

    await events.completed(codexImage("ig_typed_capped"));

    expectUndeliverableImage(events);
  });

  it.each([true, false])(
    "materializes overlapping image events with valid raw bytes: %s",
    async (validRaw) => {
      const { events } = await createProjection();
      const raw = rawImage("ig_concurrent", validRaw ? tinyPngBase64 : "not valid base64!");
      await Promise.all(
        validRaw
          ? [events.completed(codexImage("ig_concurrent")), events.raw(raw)]
          : [events.raw(raw), events.completed(nativeImage("ig_concurrent", tinyPngBase64))],
      );
      if (validRaw) {
        await events.completed(nativeImage("ig_concurrent", tinyPngBase64));
      }
      const mediaUrl = await expectImage(events);
      await expect(fs.readdir(path.dirname(mediaUrl))).resolves.toHaveLength(1);
    },
  );

  it("preserves generated media and route-specific identity after sending first to chat-source", async () => {
    const { events, bridge, execute, sources } = await createRemoteGeneratedMediaDelivery(
      async () =>
        messageResult({
          messageDelivery: { ...receipt(), primaryPlatformMessageId: "sent-media-1" },
        }),
    );
    const sent = await sendMedia(bridge, sources.first, "chat-source");
    expect(sent.success).toBe(true);
    const stagedPath = execute.mock.calls[0]?.[0].mediaUrl;
    expect(stagedPath).toEqual(
      expect.stringContaining(`${path.sep}media${path.sep}outbound${path.sep}`),
    );
    await events.complete();
    const result = events.result(bridge.telemetry);

    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    const generated = await readImages(result.toolMediaUrls);
    const first = generated.find((image) => image.base64 === tinyPngBase64);
    const second = generated.find((image) => image.base64 === SECOND_PNG_BASE64);
    expect(generated.map(({ base64 }) => base64).toSorted()).toEqual(
      [tinyPngBase64, SECOND_PNG_BASE64].toSorted(),
    );
    expect(result.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        provider: "telegram",
        to: "chat-source",
        mediaUrls: expect.arrayContaining([stagedPath, first?.url]),
      }),
    ]);
    expect(result.messagingToolSentMediaUrls).toEqual(
      result.messagingToolSentTargets?.[0]?.mediaUrls,
    );
    expect(result.messagingToolSentMediaUrls).not.toContain(second?.url);
  });

  it.each(["file-url", "error"] as const)(
    "preserves the processed internal UI attachment: %s",
    async (presentation) => {
      installCodexToolResultMiddleware((event) => {
        if (presentation === "error") {
          return { ...event.result, details: { status: "error" } };
        }
        if (typeof event.args.mediaUrl !== "string") {
          throw new Error("Expected the staged attachment path");
        }
        return {
          ...event.result,
          details: internalReply(pathToFileURL(event.args.mediaUrl).href),
        };
      });
      const { events, bridge, execute, sources } = await createRemoteGeneratedMediaDelivery(
        async (args) =>
          messageResult({
            status: "ok",
            ...internalReply(args.mediaUrl),
            messageDelivery: { ...receipt(), sourceReplyDelivered: true },
          }),
      );
      const sent = await sendMedia(bridge, sources.first);
      expect(sent.success).toBe(presentation !== "error");
      const stagedPath = execute.mock.calls[0]?.[0].mediaUrl;
      if (typeof stagedPath !== "string") {
        throw new Error("Expected the executed attachment path");
      }
      await events.complete();
      const result = events.result(bridge.telemetry);
      const mediaUrls = [pathToFileURL(stagedPath).href];
      expect(result.messagingToolSourceReplyPayloads).toEqual(
        presentation === "error" ? [] : [{ text: "Attached.", sourceReplyFinal: true, mediaUrls }],
      );
      expect(result.messagingToolSentTargets).toEqual([]);
      expect(result.messagingToolSentMediaUrls).toEqual([]);
      expect(result.messagingToolSentTexts).toEqual([]);
      expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
      const remainingImages = (await readImages(result.toolMediaUrls)).map((image) => image.base64);
      expect(remainingImages.toSorted()).toEqual(
        (presentation === "file-url"
          ? [SECOND_PNG_BASE64]
          : [tinyPngBase64, SECOND_PNG_BASE64]
        ).toSorted(),
      );
    },
  );

  it("keeps correct local image delivery evidence for a partial saved-path send", async () => {
    const params = await createParams();
    const { events } = await createProjection(params);
    const savedPath = path.join(params.workspaceDir, "generated-local.png");
    await fs.writeFile(savedPath, Buffer.from(tinyPngBase64, "base64"));
    await events.completed(nativeImage("generated-local", undefined, savedPath));
    const { bridge } = createMessageBridge(async () =>
      messageResult({ messageDelivery: receipt(true) }),
    );
    await sendMedia(bridge, savedPath, "chat-source");
    await events.complete();
    const result = events.result(bridge.telemetry);

    expect(result).toMatchObject({
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [{ provider: "telegram", to: "chat-source" }],
      messagingToolSentMediaUrls: [],
      toolMediaUrls: [savedPath],
    });
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    expect(result.messagingToolSentTargets?.flatMap((target) => target.mediaUrls ?? [])).toEqual(
      [],
    );
  });
});
