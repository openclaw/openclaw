import type { ImageContent } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "../media/constants.js";
import { buildCliArgs, loadPromptRefImages, parseCliJsonl } from "./cli-runner/helpers.js";
import * as promptImageUtils from "./pi-embedded-runner/run/images.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import * as toolImages from "./tool-images.js";

describe("loadPromptRefImages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty results when the prompt has no image refs", async () => {
    const loadImageFromRefSpy = vi.spyOn(promptImageUtils, "loadImageFromRef");
    const sanitizeImageBlocksSpy = vi.spyOn(toolImages, "sanitizeImageBlocks");

    await expect(
      loadPromptRefImages({
        prompt: "just text",
        workspaceDir: "/workspace",
      }),
    ).resolves.toEqual([]);

    expect(loadImageFromRefSpy).not.toHaveBeenCalled();
    expect(sanitizeImageBlocksSpy).not.toHaveBeenCalled();
  });

  it("passes the max-byte guardrail through load and sanitize", async () => {
    const loadedImage: ImageContent = {
      type: "image",
      data: "c29tZS1pbWFnZQ==",
      mimeType: "image/png",
    };
    const sanitizedImage: ImageContent = {
      type: "image",
      data: "c2FuaXRpemVkLWltYWdl",
      mimeType: "image/jpeg",
    };
    const sandbox = {
      root: "/sandbox",
      bridge: {} as SandboxFsBridge,
    };

    const loadImageFromRefSpy = vi
      .spyOn(promptImageUtils, "loadImageFromRef")
      .mockResolvedValueOnce(loadedImage);
    const sanitizeImageBlocksSpy = vi
      .spyOn(toolImages, "sanitizeImageBlocks")
      .mockResolvedValueOnce({ images: [sanitizedImage], dropped: 0 });

    const result = await loadPromptRefImages({
      prompt: "Look at /tmp/photo.png",
      workspaceDir: "/workspace",
      workspaceOnly: true,
      sandbox,
    });

    const [ref, workspaceDir, options] = loadImageFromRefSpy.mock.calls[0] ?? [];
    expect(ref).toMatchObject({ resolved: "/tmp/photo.png", type: "path" });
    expect(workspaceDir).toBe("/workspace");
    expect(options).toEqual({
      maxBytes: MAX_IMAGE_BYTES,
      workspaceOnly: true,
      sandbox,
    });
    expect(sanitizeImageBlocksSpy).toHaveBeenCalledWith([loadedImage], "prompt:images", {
      maxBytes: MAX_IMAGE_BYTES,
    });
    expect(result).toEqual([sanitizedImage]);
  });

  it("dedupes repeated refs and skips failed loads before sanitizing", async () => {
    const loadedImage: ImageContent = {
      type: "image",
      data: "b25lLWltYWdl",
      mimeType: "image/png",
    };

    const loadImageFromRefSpy = vi
      .spyOn(promptImageUtils, "loadImageFromRef")
      .mockResolvedValueOnce(loadedImage)
      .mockResolvedValueOnce(null);
    const sanitizeImageBlocksSpy = vi
      .spyOn(toolImages, "sanitizeImageBlocks")
      .mockResolvedValueOnce({ images: [loadedImage], dropped: 0 });

    const result = await loadPromptRefImages({
      prompt: "Compare /tmp/a.png with /tmp/a.png and /tmp/b.png",
      workspaceDir: "/workspace",
    });

    expect(loadImageFromRefSpy).toHaveBeenCalledTimes(2);
    expect(
      loadImageFromRefSpy.mock.calls.map(
        (call) => (call[0] as { resolved?: string } | undefined)?.resolved,
      ),
    ).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    expect(sanitizeImageBlocksSpy).toHaveBeenCalledWith([loadedImage], "prompt:images", {
      maxBytes: MAX_IMAGE_BYTES,
    });
    expect(result).toEqual([loadedImage]);
  });
});

describe("buildCliArgs", () => {
  it("keeps passing model overrides on resumed CLI sessions", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "codex",
          modelArg: "--model",
        },
        baseArgs: ["exec", "resume", "thread-123"],
        modelId: "gpt-5.4",
        useResume: true,
      }),
    ).toEqual(["exec", "resume", "thread-123", "--model", "gpt-5.4"]);
  });
});

describe("parseCliJsonl", () => {
  it("parses Claude stream-json result events", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-123" }),
        JSON.stringify({
          type: "result",
          session_id: "session-123",
          result: "Claude says hello",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Claude says hello",
      sessionId: "session-123",
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("preserves Claude session metadata even when the final result text is empty", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-456" }),
        JSON.stringify({
          type: "result",
          session_id: "session-456",
          result: "   ",
          usage: {
            input_tokens: 18,
            output_tokens: 0,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "",
      sessionId: "session-456",
      usage: {
        input: 18,
        output: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });
});
