import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  installCodexToolResultMiddleware,
  resetOpenClawOwnedToolHooks,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RemoteWorkspaceFileReader } from "openclaw/plugin-sdk/file-access-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { Type } from "typebox";
import { afterEach, beforeEach } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  embeddedAgentLog,
  expect,
  it,
  vi,
  tinyPngBase64,
  fs,
  path,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  forCurrentTurn,
  turnCompleted,
  type EmbeddedRunAttemptParams,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

const SECOND_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

type Projector = Awaited<ReturnType<typeof createProjector>>;
function nativeImage(id: string, result?: string, savedPath?: string) {
  return {
    type: "imageGeneration" as const,
    id,
    status: "completed" as const,
    ...(result === undefined ? {} : { result }),
    ...(savedPath ? { savedPath } : {}),
  };
}
function imageEvent(id: string, result?: string, savedPath?: string) {
  return forCurrentTurn("item/completed", { item: nativeImage(id, result, savedPath) });
}
function rawImageEvent(id: string, result = tinyPngBase64) {
  return forCurrentTurn("rawResponseItem/completed", {
    item: { type: "image_generation_call", id, status: "completed", result },
  });
}
function resultOf(projector: Projector) {
  return projector.buildResult(buildEmptyToolTelemetry());
}
async function expectImage(projector: Projector) {
  const result = resultOf(projector);
  expect(result.toolMediaUrls).toHaveLength(1);
  expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
  const mediaUrl = result.toolMediaUrls?.[0] ?? "";
  await expect(fs.readFile(mediaUrl)).resolves.toEqual(Buffer.from(tinyPngBase64, "base64"));
  return mediaUrl;
}
function createMessageBridge(
  send: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  const execute = vi.fn(send);
  const bridge = createCodexDynamicToolBridge({
    tools: [
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

async function createRemoteGeneratedMediaDelivery(
  send: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>,
) {
  const params = await createParams();
  const remoteWorkspaceRoot = "/remote/codex-workspace";
  const sources = {
    first: `${remoteWorkspaceRoot}/generated/first.png`,
    second: `${remoteWorkspaceRoot}/generated/second.png`,
    unrelated: `${remoteWorkspaceRoot}/reports/unrelated.txt`,
  };
  const bytesBySource = new Map([
    [sources.first, tinyPngBase64],
    [sources.second, SECOND_PNG_BASE64],
    [sources.unrelated, Buffer.from("Unrelated report").toString("base64")],
  ]);
  const projector = await createProjector(params, { remoteWorkspaceRoot });
  for (const [id, savedPath, result] of [
    ["generated-first", sources.first, tinyPngBase64],
    ["generated-second", sources.second, SECOND_PNG_BASE64],
  ] as const) {
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "imageGeneration", id, status: "completed", savedPath, result },
      }),
    );
  }
  const { bridge, execute } = createMessageBridge(send, {
    workspaceDir: params.workspaceDir,
    remoteWorkspaceRoot,
  });
  bridge.setRemoteWorkspaceFileReader?.(async ({ path: source }) => {
    const dataBase64 = bytesBySource.get(source);
    if (!dataBase64) {
      throw new Error(`Unexpected synthetic media source: ${source}`);
    }
    return Buffer.from(dataBase64, "base64");
  });
  return { projector, bridge, execute, sources };
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
  it("fences direct tool-result callbacks after blocked media when projection closes", async () => {
    const media = createDeferred<Buffer>();
    const readRemoteWorkspaceFile = vi.fn<RemoteWorkspaceFileReader>(() => media.promise);
    const onToolResult = vi.fn();
    const projector = await createProjector(
      { ...(await createParams()), verboseLevel: "full", onToolResult },
      { remoteWorkspaceRoot: "/remote/workspace", readRemoteWorkspaceFile },
    );
    const pending = projector.handleNotification(
      turnCompleted([
        {
          type: "imageGeneration",
          id: "blocked-image",
          status: "completed",
          result: "",
          revisedPrompt: null,
          savedPath: "/remote/workspace/image.png",
        },
        {
          type: "commandExecution",
          id: "command-after-image",
          command: "echo late-output",
          cwd: "/remote/workspace",
          commandActions: [],
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: "late-output",
          exitCode: 0,
          durationMs: 1,
        },
      ]),
    );
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

  it("never exposes a remote image path when remote file transfer is unavailable", async () => {
    const projector = await createProjector(undefined, {
      remoteWorkspaceRoot: "/remote/codex-workspace",
    });

    await projector.handleNotification(
      imageEvent(
        "ig_remote_unavailable",
        undefined,
        "/remote/codex-home/generated_images/session-1/ig_remote_unavailable.png",
      ),
    );

    const result = resultOf(projector);
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("preserves image side-effect state when remote file transfer fails", async () => {
    const readRemoteWorkspaceFile = vi.fn(async () => {
      throw new Error("remote generated image is unavailable");
    });
    const projector = await createProjector(undefined, {
      remoteWorkspaceRoot: "/remote/codex-workspace",
      readRemoteWorkspaceFile,
    });

    await projector.handleNotification(
      imageEvent(
        "ig_remote_transfer_failed",
        undefined,
        "/remote/codex-home/generated_images/session-1/ig_transfer_failed.png",
      ),
    );

    const result = resultOf(projector);
    expect(readRemoteWorkspaceFile).toHaveBeenCalledOnce();
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("does not let delayed raw completion consume a newer assistant echo", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "agentMessage", id: "answer-a", text: "rewritten A" },
      }),
    );

    const rawAnswerA = projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "answer-a",
          role: "assistant",
          content: [{ type: "output_text", text: "original A" }],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "agentMessage", id: "answer-b", text: "rewritten B" },
      }),
    );
    await rawAnswerA;
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "answer-b",
          role: "assistant",
          content: [{ type: "output_text", text: "original B" }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = resultOf(projector);
    expect(result.assistantTexts).toEqual(["rewritten B"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "rewritten B" }]);
  });

  it("rejects oversized typed Codex images instead of using a remote saved path", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const projector = await createProjector({
      ...(await createParams()),
      config: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    } as EmbeddedRunAttemptParams);

    await projector.handleNotification(
      imageEvent(
        "ig_typed_capped",
        tinyPngBase64,
        "/home/dev-user/.codex/generated_images/session-1/ig_typed_capped.png",
      ),
    );

    const result = resultOf(projector);

    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
    expect(warn).toHaveBeenCalledWith(
      "codex app-server native image generation result exceeds media limit",
      expect.objectContaining({ itemId: "ig_typed_capped" }),
    );
  });

  it("materializes overlapping typed and raw image events only once", async () => {
    const projector = await createProjector();

    await Promise.all([
      projector.handleNotification(
        imageEvent(
          "ig_concurrent",
          tinyPngBase64,
          "/home/dev-user/.codex/generated_images/session-1/ig_concurrent.png",
        ),
      ),
      projector.handleNotification(rawImageEvent("ig_concurrent", tinyPngBase64)),
    ]);

    await projector.handleNotification(imageEvent("ig_concurrent", tinyPngBase64));
    const mediaUrl = await expectImage(projector);
    await expect(fs.readdir(path.dirname(mediaUrl))).resolves.toHaveLength(1);
  });

  it("retries valid typed image bytes after an overlapping invalid raw event", async () => {
    const projector = await createProjector();

    await Promise.all([
      projector.handleNotification(rawImageEvent("ig_retry_valid", "not valid base64!")),
      projector.handleNotification(imageEvent("ig_retry_valid", tinyPngBase64)),
    ]);

    await expectImage(projector);
  });

  it.each([{ attachment: "first", target: "chat-source" }] as const)(
    "preserves generated media and route-specific identity after sending $attachment to $target",
    async ({ attachment, target }) => {
      const { projector, bridge, execute, sources } = await createRemoteGeneratedMediaDelivery(
        async () => ({
          content: [{ type: "text", text: "Sent." }],
          details: {
            messageDelivery: { ...receipt(), primaryPlatformMessageId: "sent-media-1" },
          },
        }),
      );
      const sent = await sendMedia(bridge, sources[attachment], target);
      expect(sent.success).toBe(true);
      const stagedPath = execute.mock.calls[0]?.[0].mediaUrl;
      expect(stagedPath).toEqual(
        expect.stringContaining(`${path.sep}media${path.sep}outbound${path.sep}`),
      );
      await projector.handleNotification(turnCompleted());
      const result = projector.buildResult(bridge.telemetry);

      expect(result.toolMediaUrls).toHaveLength(2);
      expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
      const generated = await Promise.all(
        (result.toolMediaUrls ?? []).map(async (url) => ({
          url,
          base64: (await fs.readFile(url)).toString("base64"),
        })),
      );
      const first = generated.find((image) => image.base64 === tinyPngBase64);
      const second = generated.find((image) => image.base64 === SECOND_PNG_BASE64);
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(result.messagingToolSentTargets).toHaveLength(1);
      const delivery = result.messagingToolSentTargets?.[0];
      expect(delivery).toMatchObject({ provider: "telegram", to: target });
      expect(delivery?.mediaUrls).toContain(stagedPath);
      expect(result.messagingToolSentMediaUrls).toEqual(delivery?.mediaUrls);
      expect(delivery?.mediaUrls).not.toContain(second?.url);
      expect(delivery?.mediaUrls).toContain(first?.url);
    },
  );

  it.each(["replaced", "file-url", "error"] as const)(
    "preserves the processed internal UI attachment: %s",
    async (presentation) => {
      const replacementUrl = "https://example.test/filtered-preview.png";
      installCodexToolResultMiddleware((event) => {
        let processedUrl = replacementUrl;
        if (presentation === "file-url") {
          if (typeof event.args.mediaUrl !== "string") {
            throw new Error("Expected the staged attachment path");
          }
          processedUrl = pathToFileURL(event.args.mediaUrl).href;
        }
        return {
          ...event.result,
          details:
            presentation === "replaced" || presentation === "file-url"
              ? {
                  deliveryStatus: "sent",
                  sourceReplySink: "internal-ui",
                  sourceReply: {
                    text: presentation === "replaced" ? "Filtered attachment." : "Attached.",
                    mediaUrls: [processedUrl],
                  },
                }
              : { status: "error" },
        };
      });
      const { projector, bridge, execute, sources } = await createRemoteGeneratedMediaDelivery(
        async (args) => ({
          content: [{ type: "text", text: "Sent to current chat." }],
          details: {
            status: "ok",
            deliveryStatus: "sent",
            sourceReplySink: "internal-ui",
            sourceReply: { text: "Attached.", mediaUrls: [args.mediaUrl] },
            messageDelivery: { ...receipt(), sourceReplyDelivered: true },
          },
        }),
      );
      const sent = await sendMedia(bridge, sources.first);
      expect(sent.success).toBe(presentation !== "error");
      const stagedPath = execute.mock.calls[0]?.[0].mediaUrl;
      if (typeof stagedPath !== "string") {
        throw new Error("Expected the executed attachment path");
      }
      await projector.handleNotification(turnCompleted());
      const result = projector.buildResult(bridge.telemetry);

      expect(result.messagingToolSourceReplyPayloads).toEqual(
        presentation === "error"
          ? []
          : [
              {
                text: presentation === "replaced" ? "Filtered attachment." : "Attached.",
                mediaUrls: [
                  presentation === "replaced" ? replacementUrl : pathToFileURL(stagedPath).href,
                ],
              },
            ],
      );
      expect(result.messagingToolSentTargets).toEqual([]);
      expect(result.messagingToolSentMediaUrls).toEqual([]);
      expect(result.messagingToolSentTexts).toEqual([]);
      const sentGeneratedImage = presentation === "file-url";
      expect(result.toolMediaUrls).toHaveLength(sentGeneratedImage ? 1 : 2);
      expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
      const remainingImages = await Promise.all(
        (result.toolMediaUrls ?? []).map(async (url) =>
          (await fs.readFile(url)).toString("base64"),
        ),
      );
      expect(remainingImages).toContain(SECOND_PNG_BASE64);
      if (sentGeneratedImage) {
        expect(remainingImages).not.toContain(tinyPngBase64);
      } else {
        expect(remainingImages).toContain(tinyPngBase64);
      }
    },
  );

  it.each([{ name: "a partial saved-path send", partialDelivery: true, useFileUrl: false }])(
    "keeps correct local image delivery evidence for $name",
    async ({ partialDelivery, useFileUrl }) => {
      const params = await createParams();
      const projector = await createProjector(params);
      const savedPath = path.join(params.workspaceDir, "generated-local.png");
      await fs.writeFile(savedPath, Buffer.from(tinyPngBase64, "base64"));
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "imageGeneration",
            id: "generated-local",
            status: "completed",
            savedPath,
            ...(useFileUrl ? { result: tinyPngBase64 } : {}),
          },
        }),
      );
      const { bridge } = createMessageBridge(async () => ({
        content: [{ type: "text", text: "Message delivery receipt." }],
        details: { messageDelivery: receipt(partialDelivery) },
      }));
      await sendMedia(
        bridge,
        useFileUrl ? pathToFileURL(savedPath).href : savedPath,
        "chat-source",
      );
      await projector.handleNotification(turnCompleted());
      const result = projector.buildResult(bridge.telemetry);

      expect(result.didSendViaMessagingTool).toBe(true);
      expect(result.messagingToolSentTargets).toEqual([
        expect.objectContaining({ provider: "telegram", to: "chat-source" }),
      ]);
      expect(result.toolMediaUrls).toHaveLength(1);
      expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
      if (partialDelivery) {
        expect(result.messagingToolSentMediaUrls).toEqual([]);
        expect(
          result.messagingToolSentTargets?.flatMap((target) => target.mediaUrls ?? []),
        ).toEqual([]);
        expect(result.toolMediaUrls).toEqual([savedPath]);
      } else {
        const generatedUrl = result.toolMediaUrls?.[0];
        expect(generatedUrl).not.toBe(savedPath);
        expect(result.messagingToolSentMediaUrls).toContain(generatedUrl);
        expect(result.messagingToolSentTargets?.[0]?.mediaUrls).toContain(generatedUrl);
      }
    },
  );
});
