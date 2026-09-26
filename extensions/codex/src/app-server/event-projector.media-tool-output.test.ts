import { resetOpenClawOwnedToolHooks } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach } from "vitest";
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
  forCurrentTurn,
  type EmbeddedRunAttemptParams,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

const SECOND_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

let openClawState: OpenClawTestState;
beforeEach(async () => {
  openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-codex-tool-output-media-state-",
  });
});
afterEach(async () => {
  resetOpenClawOwnedToolHooks();
  await openClawState.cleanup();
});

describe("CodexAppServerEventProjector nested tool-output media", () => {
  it.each([
    {
      type: "custom_tool_call_output",
      mimeType: "image/png",
      identity: { call_id: "call_view_image_1" },
      identityLabel: "call_id",
    },
    {
      type: "function_call_output",
      mimeType: "application/octet-stream",
      identity: { call_id: "call_view_image_1" },
      identityLabel: "call_id",
    },
    {
      type: "custom_tool_call_output",
      mimeType: "image/png",
      identity: { id: "resp_view_image_1" },
      identityLabel: "id",
    },
  ])(
    "saves nested images from raw $type ($mimeType, $identityLabel) without generation side effects",
    async ({ type, mimeType, identity }) => {
      const projector = await createProjector();
      const dataUrl = `data:${mimeType};base64,${tinyPngBase64}`;
      const notification = forCurrentTurn("rawResponseItem/completed", {
        item: {
          type,
          ...identity,
          output: [
            { type: "input_text", text: "Script completed" },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      });

      await projector.handleNotification(notification);
      await projector.handleNotification(notification);

      const result = projector.buildResult(buildEmptyToolTelemetry());
      const mediaUrl = result.toolMediaUrls?.[0];

      expect(result.toolMediaUrls).toHaveLength(1);
      expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
      expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-image-generation${path.sep}`);
      await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
        Buffer.from(tinyPngBase64, "base64"),
      );
      expect(JSON.stringify(result.messagesSnapshot)).not.toContain(dataUrl);
      expect(JSON.stringify(result.messagesSnapshot)).not.toContain(tinyPngBase64);
      expect(result.replayMetadata).toStrictEqual({
        hadPotentialSideEffects: false,
        replaySafe: true,
      });
    },
  );

  it("ignores text-only and identity-less nested tool output", async () => {
    const projector = await createProjector();
    const dataUrl = `data:image/png;base64,${tinyPngBase64}`;

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: "call_text_only",
          output: [{ type: "input_text", text: "Script completed" }],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "function_call_output",
          output: [{ type: "input_image", image_url: dataUrl }],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(tinyPngBase64);
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: false,
      replaySafe: true,
    });
  });

  it("keeps screenshot delivery separate from generated-image side effects", async () => {
    const projector = await createProjector();
    const screenshotUrl = `data:image/png;base64,${tinyPngBase64}`;

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: "call_view_image_mixed",
          output: [{ type: "input_image", image_url: screenshotUrl }],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "image_generation_call",
          id: "ig_raw_mixed",
          status: "completed",
          result: SECOND_PNG_BASE64,
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaBytes = await Promise.all(
      (result.toolMediaUrls ?? []).map((mediaUrl) => fs.readFile(mediaUrl)),
    );

    expect(result.toolMediaUrls).toHaveLength(2);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    expect(mediaBytes).toEqual(
      expect.arrayContaining([
        Buffer.from(tinyPngBase64, "base64"),
        Buffer.from(SECOND_PNG_BASE64, "base64"),
      ]),
    );
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(screenshotUrl);
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("rejects malformed, non-image, and oversized nested tool-output images", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const projector = await createProjector({
      ...(await createParams()),
      config: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    } as EmbeddedRunAttemptParams);

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "function_call_output",
          call_id: "call_invalid_images",
          output: [
            { type: "input_image", image_url: "https://example.test/image.png" },
            { type: "input_image", image_url: `data:image/png;${"x;".repeat(5_000)}` },
            {
              type: "input_image",
              image_url: `data:application/octet-stream;base64,${Buffer.from("x").toString("base64")}`,
            },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${tinyPngBase64}`,
            },
          ],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: false,
      replaySafe: true,
    });
    expect(warn).toHaveBeenCalledWith(
      "codex app-server tool output image exceeds media limit",
      expect.objectContaining({ itemId: "call_invalid_images:image:3" }),
    );
  });

  it("keeps host dynamic-tool output out of reply media", async () => {
    const projector = await createProjector();
    const dataUrl = `data:image/png;base64,${tinyPngBase64}`;
    // The host executes this call and forwards its pixels to Codex for model
    // use only; its raw echo must not republish them as reply attachments.
    projector.recordDynamicToolCall({ callId: "call_browser_snapshot", tool: "browser" });
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "function_call_output",
          call_id: "call_browser_snapshot",
          output: [
            { type: "input_text", text: "snapshot captured" },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(tinyPngBase64);
  });

  it.each([{ order: "imageView first" as const }, { order: "raw output first" as const }])(
    "suppresses a source reply that already sent the viewed image ($order)",
    async ({ order }) => {
      const projector = await createProjector();
      const sourcePath = "/workspace/screenshot.png";
      const imageViewCompleted = forCurrentTurn("item/completed", {
        item: { type: "imageView", id: "call_view_source", path: sourcePath },
      });
      const rawOutputCompleted = forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: "call_view_source",
          output: [{ type: "input_image", image_url: `data:image/png;base64,${tinyPngBase64}` }],
        },
      });
      if (order === "imageView first") {
        await projector.handleNotification(imageViewCompleted);
        await projector.handleNotification(rawOutputCompleted);
      } else {
        await projector.handleNotification(rawOutputCompleted);
        await projector.handleNotification(imageViewCompleted);
      }

      const result = projector.buildResult({
        ...buildEmptyToolTelemetry(),
        confirmedMediaDeliveries: [
          { kind: "sourceReply", sourceUrls: ["file:///workspace/screenshot.png"] },
        ],
      });

      expect(result.toolMediaUrls).toBeUndefined();
      expect(result.hostOwnedToolMediaUrls).toBeUndefined();
    },
  );

  it("attributes a confirmed original-path send to its target once", async () => {
    const projector = await createProjector();
    const sourcePath = "/workspace/screenshot.png";
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "imageView", id: "call_view_target", path: sourcePath },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          call_id: "call_view_target",
          output: [{ type: "input_image", image_url: `data:image/png;base64,${tinyPngBase64}` }],
        },
      }),
    );

    const target = { tool: "message", provider: "control-ui" };
    const result = projector.buildResult({
      ...buildEmptyToolTelemetry(),
      messagingToolSentTargets: [target],
      confirmedMediaDeliveries: [{ kind: "outbound", target, sourceUrls: [sourcePath] }],
    });

    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.messagingToolSentTargets).toHaveLength(1);
    expect(result.messagingToolSentTargets[0]?.mediaUrls).toEqual(result.toolMediaUrls);
  });
});
