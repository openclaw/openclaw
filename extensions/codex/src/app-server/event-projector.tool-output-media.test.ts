import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach } from "vitest";
import {
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  describe,
  embeddedAgentLog,
  expect,
  forCurrentTurn,
  fs,
  it,
  path,
  registerCodexEventProjectorTestLifecycle,
  tinyPngBase64,
  type EmbeddedRunAttemptParams,
  vi,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

function rawToolOutputWithImage(params?: {
  type?: "custom_tool_call_output" | "function_call_output";
  imageUrl?: string;
}) {
  return {
    type: params?.type ?? "custom_tool_call_output",
    id: "ctco_issue_153949",
    call_id: "call_issue_153949",
    output: [
      { type: "input_text", text: "<<ImageDisplayed>>Image Size: 1365x768." },
      {
        type: "input_image",
        image_url: params?.imageUrl ?? `data:image/png;base64,${tinyPngBase64}`,
      },
    ],
  };
}

let openClawState: OpenClawTestState;
beforeEach(async () => {
  openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-codex-tool-output-media-state-",
  });
});
afterEach(async () => {
  await openClawState.cleanup();
});

describe("CodexAppServerEventProjector tool-output media projection", () => {
  it("projects the sanitized issue #153949 custom tool-output image as reply media", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: rawToolOutputWithImage(),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-after-screenshot",
          text: "The screenshot is attached.",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];

    expect(result.assistantTexts).toEqual(["The screenshot is attached."]);
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
    expect(mediaUrl).toContain(`${path.sep}media${path.sep}tool-output-images${path.sep}`);
    expect(mediaUrl?.endsWith(".png")).toBe(true);
    await expect(fs.readFile(mediaUrl ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
    expect(result.replayMetadata).toStrictEqual({
      hadPotentialSideEffects: false,
      replaySafe: true,
    });
  });

  it("projects data-URL images from applicable function call outputs", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: rawToolOutputWithImage({ type: "function_call_output" }),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "imageView",
          id: "call_issue_153949",
          path: "/workspace/native-screenshot.png",
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toHaveLength(1);
    await expect(fs.readFile(result.toolMediaUrls?.[0] ?? "")).resolves.toEqual(
      Buffer.from(tinyPngBase64, "base64"),
    );
  });

  it("does not promote unowned function-call images into reply attachments", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: rawToolOutputWithImage({ type: "function_call_output" }),
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
  });

  it("preserves model-only policy for raw image echoes from host dynamic tools", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: rawToolOutputWithImage({ type: "function_call_output" }),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "dynamicToolCall",
          id: "call_issue_153949",
          tool: "browser",
          status: "inProgress",
          arguments: {},
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
  });

  it("retains the native image path for confirmed source-reply matching", async () => {
    const projector = await createProjector();
    const sourcePath = "/workspace/native-screenshot.png";

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: rawToolOutputWithImage(),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "imageView", id: "call_issue_153949", path: sourcePath },
      }),
    );

    const result = projector.buildResult({
      ...buildEmptyToolTelemetry(),
      confirmedMediaDeliveries: [{ kind: "sourceReply", sourceUrls: [sourcePath] }],
    });
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
  });

  it.each([
    ["malformed data URL", "data:image/png;base64,not-base64!"],
    ["non-image bytes", `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`],
    [
      "unsupported image MIME",
      `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
    ],
    ["external URL", "https://example.test/screenshot.png"],
    ["file URL", "file:///tmp/screenshot.png"],
  ])("ignores unsupported tool-output image content: %s", async (_name, imageUrl) => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: rawToolOutputWithImage({ imageUrl }),
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
  });

  it("rejects oversized tool-output images before persistence", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const projector = await createProjector({
      ...(await createParams()),
      config: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    } as EmbeddedRunAttemptParams);

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: rawToolOutputWithImage(),
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "codex app-server tool output image exceeds media limit",
      expect.objectContaining({ itemId: "ctco_issue_153949:input-image:1" }),
    );
  });

  it("bounds aggregate persisted bytes across raw tool-output records", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const decodedBytes = Buffer.from(tinyPngBase64, "base64").byteLength;
    const projector = await createProjector({
      ...(await createParams()),
      config: {
        agents: { defaults: { mediaMaxMb: (decodedBytes * 2 - 1) / (1024 * 1024) } },
      },
    } as EmbeddedRunAttemptParams);

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: rawToolOutputWithImage(),
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          ...rawToolOutputWithImage(),
          id: "ctco_second",
          call_id: "call_second",
          output: [{ type: "input_image", image_url: `data:image/png;base64,${tinyPngBase64}` }],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "codex app-server tool output images exceed aggregate media limit",
      expect.objectContaining({ itemId: "ctco_second:input-image:0" }),
    );
  });

  it("bounds image count across raw records without charging duplicate IDs twice", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const projector = await createProjector();
    const notifications = Array.from({ length: 9 }, (_, index) =>
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          ...rawToolOutputWithImage(),
          id: `ctco_count_${index}`,
          call_id: `call_count_${index}`,
          output: [{ type: "input_image", image_url: `data:image/png;base64,${tinyPngBase64}` }],
        },
      }),
    );

    await projector.handleNotification(notifications[0]!);
    await projector.handleNotification(notifications[0]!);
    for (const notification of notifications.slice(1)) {
      await projector.handleNotification(notification);
    }

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toHaveLength(8);
    expect(warn).toHaveBeenCalledWith(
      "codex app-server tool output image count exceeds limit",
      expect.objectContaining({ outputId: "ctco_count_8", maxImages: 8 }),
    );
  });

  it("dedupes repeated raw tool-output image events", async () => {
    const projector = await createProjector();
    const notification = forCurrentTurn("rawResponseItem/completed", {
      item: rawToolOutputWithImage(),
    });

    await Promise.all([
      projector.handleNotification(notification),
      projector.handleNotification(notification),
    ]);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const mediaUrl = result.toolMediaUrls?.[0];
    expect(result.toolMediaUrls).toHaveLength(1);
    await expect(fs.readdir(path.dirname(mediaUrl ?? ""))).resolves.toHaveLength(1);
  });

  it("does not project text-only raw tool outputs as media", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "custom_tool_call_output",
          id: "ctco_text_only",
          call_id: "call_text_only",
          output: [{ type: "input_text", text: "No screenshot was produced." }],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.toolMediaUrls).toBeUndefined();
    expect(result.hostOwnedToolMediaUrls).toBeUndefined();
  });
});
