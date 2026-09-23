import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  installCodexToolResultMiddleware,
  resetOpenClawOwnedToolHooks,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
import type { CodexRemoteWorkspaceFileReader } from "./remote-workspace-media.js";

registerCodexEventProjectorTestLifecycle();

const SECOND_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

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
    hookContext: { workspaceDir: params.workspaceDir, remoteWorkspaceRoot },
  });
  bridge.setRemoteWorkspaceFileReader?.(async ({ path: source }) => {
    const dataBase64 = bytesBySource.get(source);
    if (!dataBase64) {
      throw new Error(`Unexpected synthetic media source: ${source}`);
    }
    return { dataBase64 };
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
  it("saves native Codex image-generation snapshots into gateway-managed media", async () => {
    const projector = await createProjector();
    const savedPath = "/home/dev-user/.codex/generated_images/session-1/ig_123.png";

    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageGeneration",
          id: "ig_123",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          result: tinyPngBase64,
          savedPath,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.assistantTexts).toStrictEqual([]);
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    expect(mediaUrl).not.toBe(savedPath);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("saves typed Codex image-generation completions without a raw response or saved path", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_typed_only",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          result: tinyPngBase64,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
  });

  it("does not expose a remote saved path when typed image bytes are invalid", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_typed_invalid",
          status: "completed",
          result: "not valid base64!",
          savedPath: "/home/dev-user/.codex/generated_images/session-1/ig_typed_invalid.png",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("fetches saved-path-only remote images over the bounded Codex command protocol", async () => {
    const readRemoteWorkspaceFile = vi.fn<CodexRemoteWorkspaceFileReader>(async () => ({
      dataBase64: tinyPngBase64,
    }));
    const runAbort = new AbortController();
    const projector = await createProjector(undefined, {
      remoteWorkspaceRoot: "/remote/codex-workspace",
      readRemoteWorkspaceFile,
      remoteWorkspaceRequestTimeoutMs: 90_000,
      runAbortSignal: runAbort.signal,
    });
    const savedPath = "/remote/codex-home/generated_images/session-1/ig_saved_only.png";

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_saved_only",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          savedPath,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(readRemoteWorkspaceFile).toHaveBeenCalledWith({
      path: savedPath,
      maxBytes: expect.any(Number),
      signal: expect.any(AbortSignal),
      timeoutMs: 90_000,
    });
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.toolMediaUrls?.[0]).not.toBe(savedPath);
    await expect(fs.readFile(result.toolMediaUrls?.[0] ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
    const signal = readRemoteWorkspaceFile.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    runAbort.abort();
    expect(signal?.aborted).toBe(true);
  });

  it.each([false, true])(
    "fences direct tool-result callbacks after blocked media when projection closed=%s",
    async (closed) => {
      const media = createDeferred<{ dataBase64: string }>();
      const readRemoteWorkspaceFile = vi.fn<CodexRemoteWorkspaceFileReader>(() => media.promise);
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
        if (closed) {
          await projector.closeProjection();
        }
        expect(signal?.aborted === true).toBe(closed);
        media.resolve({ dataBase64: tinyPngBase64 });
        await pending;
        if (closed) {
          expect(onToolResult).not.toHaveBeenCalled();
        } else {
          expect(onToolResult).toHaveBeenCalledWith(
            expect.objectContaining({ text: expect.stringContaining("late-output") }),
          );
        }
      } finally {
        media.resolve({ dataBase64: tinyPngBase64 });
        await pending;
      }
    },
  );

  it("never exposes a remote image path when remote file transfer is unavailable", async () => {
    const projector = await createProjector(undefined, {
      remoteWorkspaceRoot: "/remote/codex-workspace",
    });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_remote_unavailable",
          status: "completed",
          savedPath: "/remote/codex-home/generated_images/session-1/ig_remote_unavailable.png",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
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
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_remote_transfer_failed",
          status: "completed",
          savedPath: "/remote/codex-home/generated_images/session-1/ig_transfer_failed.png",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(readRemoteWorkspaceFile).toHaveBeenCalledOnce();
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("saves raw Codex image-generation results as reply media", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: "ig_raw_1",
          status: "generating",
          result: tinyPngBase64,
          revised_prompt: "A tiny blue square",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.assistantTexts).toStrictEqual([]);
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
    expect(mediaUrl?.endsWith(".png")).toBe(true);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
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

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["rewritten B"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "rewritten B" }]);
  });

  it("keeps raw image-generation results replay-invalid when media save fails", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const projector = await createProjector({
      ...(await createParams()),
      config: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    } as EmbeddedRunAttemptParams);

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: "ig_raw_capped",
          status: "completed",
          result: tinyPngBase64,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
    expect(warn).toHaveBeenCalledWith(
      "codex app-server raw image generation result exceeds media limit",
      expect.objectContaining({ itemId: "ig_raw_capped" }),
    );
  });

  it("rejects oversized typed Codex images instead of using a remote saved path", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const projector = await createProjector({
      ...(await createParams()),
      config: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    } as EmbeddedRunAttemptParams);

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_typed_capped",
          status: "completed",
          result: tinyPngBase64,
          savedPath: "/home/dev-user/.codex/generated_images/session-1/ig_typed_capped.png",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

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

  it("dedupes raw and typed Codex image-generation media for the same item", async () => {
    const projector = await createProjector();
    const savedPath = "/tmp/codex-home/generated_images/session-1/ig_123.png";

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: "ig_123",
          status: "generating",
          result: tinyPngBase64,
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageGeneration",
          id: "ig_123",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          result: tinyPngBase64,
          savedPath,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.toolMediaUrls?.[0]).not.toBe(savedPath);
  });

  it("materializes overlapping typed and raw image events only once", async () => {
    const projector = await createProjector();

    await Promise.all([
      projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "imageGeneration",
            id: "ig_concurrent",
            status: "completed",
            revisedPrompt: "A tiny blue square",
            result: tinyPngBase64,
            savedPath: "/home/dev-user/.codex/generated_images/session-1/ig_concurrent.png",
          },
        }),
      ),
      projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "image_generation_call",
            id: "ig_concurrent",
            status: "completed",
            result: tinyPngBase64,
          },
        }),
      ),
    ]);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
    await expect(fs.readdir(path.dirname(mediaUrl ?? ""))).resolves.toHaveLength(1);
  });

  it("retries valid typed image bytes after an overlapping invalid raw event", async () => {
    const projector = await createProjector();

    await Promise.all([
      projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "image_generation_call",
            id: "ig_retry_valid",
            status: "completed",
            result: "not valid base64!",
          },
        }),
      ),
      projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "imageGeneration",
            id: "ig_retry_valid",
            status: "completed",
            result: tinyPngBase64,
            savedPath: "/home/dev-user/.codex/generated_images/session-1/ig_retry_valid.png",
          },
        }),
      ),
    ]);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toHaveLength(1);
    await expect(fs.readFile(result.toolMediaUrls?.[0] ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
  });

  it("prefers gateway-managed image media when the typed event arrives first", async () => {
    const projector = await createProjector();
    const savedPath = "/home/dev-user/.codex/generated_images/session-1/ig_123.png";

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageGeneration",
          id: "ig_123",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          result: tinyPngBase64,
          savedPath,
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: "ig_123",
          status: "generating",
          result: tinyPngBase64,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.toolMediaUrls).toHaveLength(1);
    expect(mediaUrl).not.toBe(savedPath);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
  });

  it("preserves distinct raw image-generation items with identical image bytes", async () => {
    const projector = await createProjector();

    for (const id of ["ig_raw_1", "ig_raw_2"]) {
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "image_generation_call",
            id,
            status: "generating",
            result: tinyPngBase64,
          },
        }),
      );
    }

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toHaveLength(2);
    expect(new Set(result.toolMediaUrls)).toHaveLength(2);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
  });

  it.each([
    { attachment: "first", target: "chat-source" },
    { attachment: "first", target: "chat-other" },
    { attachment: "unrelated", target: "chat-source" },
  ] as const)(
    "preserves generated media and route-specific identity after sending $attachment to $target",
    async ({ attachment, target }) => {
      const { projector, bridge, execute, sources } = await createRemoteGeneratedMediaDelivery(
        async () => ({
          content: [{ type: "text", text: "Sent." }],
          details: {
            messageDelivery: {
              status: "settled",
              primaryPlatformMessageId: "sent-media-1",
              partialDelivery: false,
              createdThreadIds: [],
            },
          },
        }),
      );
      const sent = await bridge.handleToolCall({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "send-generated-media",
        namespace: null,
        tool: "message",
        arguments: {
          action: "send",
          provider: "telegram",
          to: target,
          mediaUrl: sources[attachment],
        },
      });
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
      if (attachment === "first") {
        expect(delivery?.mediaUrls).toContain(first?.url);
      } else {
        expect(delivery?.mediaUrls).not.toContain(first?.url);
      }
    },
  );

  it.each([
    { attachment: "first", presentation: "unchanged" },
    { attachment: "unrelated", presentation: "unchanged" },
    { attachment: "first", presentation: "replaced" },
    { attachment: "first", presentation: "file-url" },
    { attachment: "first", presentation: "stripped" },
    { attachment: "first", presentation: "error" },
  ] as const)(
    "preserves the processed internal UI attachment: $attachment, $presentation",
    async ({ attachment, presentation }) => {
      const replacementUrl = "https://example.test/filtered-preview.png";
      if (presentation !== "unchanged") {
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
                : { status: presentation === "error" ? "error" : "ok" },
          };
        });
      }
      const { projector, bridge, execute, sources } = await createRemoteGeneratedMediaDelivery(
        async (args) => ({
          content: [{ type: "text", text: "Sent to current chat." }],
          details: {
            status: "ok",
            deliveryStatus: "sent",
            sourceReplySink: "internal-ui",
            sourceReply: { text: "Attached.", mediaUrls: [args.mediaUrl] },
            messageDelivery: {
              status: "settled",
              sourceReplyDelivered: true,
              partialDelivery: false,
              createdThreadIds: [],
            },
          },
        }),
      );
      const sent = await bridge.handleToolCall({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "send-internal-generated-media",
        namespace: null,
        tool: "message",
        arguments: {
          action: "send",
          message: "Original source reply arguments",
          mediaUrl: sources[attachment],
        },
      });
      expect(sent.success).toBe(presentation !== "error");
      const stagedPath = execute.mock.calls[0]?.[0].mediaUrl;
      if (typeof stagedPath !== "string") {
        throw new Error("Expected the executed attachment path");
      }
      await projector.handleNotification(turnCompleted());
      const result = projector.buildResult(bridge.telemetry);

      expect(result.messagingToolSourceReplyPayloads).toEqual(
        presentation === "stripped" || presentation === "error"
          ? []
          : [
              {
                text: presentation === "replaced" ? "Filtered attachment." : "Attached.",
                mediaUrl:
                  presentation === "replaced"
                    ? replacementUrl
                    : presentation === "file-url"
                      ? pathToFileURL(stagedPath).href
                      : stagedPath,
                mediaUrls: [
                  presentation === "replaced"
                    ? replacementUrl
                    : presentation === "file-url"
                      ? pathToFileURL(stagedPath).href
                      : stagedPath,
                ],
              },
            ],
      );
      expect(result.messagingToolSentTargets).toEqual([]);
      expect(result.messagingToolSentMediaUrls).toEqual([]);
      expect(result.messagingToolSentTexts).toEqual([]);
      const sentGeneratedImage =
        attachment === "first" && (presentation === "unchanged" || presentation === "file-url");
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

  it.each([
    { name: "a partial saved-path send", partialDelivery: true, useFileUrl: false },
    { name: "a confirmed file-URL send", partialDelivery: false, useFileUrl: true },
  ])(
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
      const bridge = createCodexDynamicToolBridge({
        tools: [
          {
            name: "message",
            label: "Message",
            description: "Send a synthetic attachment",
            parameters: Type.Object({}, { additionalProperties: true }),
            execute: async () => ({
              content: [{ type: "text", text: "Message delivery receipt." }],
              details: {
                messageDelivery: {
                  status: "settled",
                  partialDelivery,
                  createdThreadIds: [],
                },
              },
            }),
          },
        ],
        signal: new AbortController().signal,
      });
      await bridge.handleToolCall({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "send-local-partial",
        namespace: null,
        tool: "message",
        arguments: {
          action: "send",
          provider: "telegram",
          to: "chat-source",
          mediaUrl: useFileUrl ? pathToFileURL(savedPath).href : savedPath,
        },
      });
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

  it("propagates source reply delivery without destination telemetry", async () => {
    const projector = await createProjector();

    const result = projector.buildResult({
      ...buildEmptyToolTelemetry(),
      didSendViaMessagingTool: true,
      didDeliverSourceReplyViaMessageTool: true,
      sourceReplyDelivered: true,
    });

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(result.sourceReplyDelivered).toBe(true);
  });
});
