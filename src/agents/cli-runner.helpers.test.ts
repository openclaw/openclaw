import type { ImageContent } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "../media/constants.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

const mocks = vi.hoisted(() => ({
  loadImageFromRef: vi.fn(),
  sanitizeImageBlocks: vi.fn(),
}));

vi.mock("./pi-embedded-runner/run/images.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-embedded-runner/run/images.js")>();
  return {
    ...actual,
    loadImageFromRef: (...args: unknown[]) => mocks.loadImageFromRef(...args),
  };
});

vi.mock("./tool-images.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-images.js")>();
  return {
    ...actual,
    sanitizeImageBlocks: (...args: unknown[]) => mocks.sanitizeImageBlocks(...args),
  };
});

import { loadPromptRefImages } from "./cli-runner/helpers.js";

describe("loadPromptRefImages", () => {
  beforeEach(() => {
    mocks.loadImageFromRef.mockReset();
    mocks.sanitizeImageBlocks.mockReset();
    mocks.sanitizeImageBlocks.mockImplementation(async (images: ImageContent[]) => ({
      images,
      dropped: 0,
    }));
  });

  it("returns empty results when the prompt has no image refs", async () => {
    await expect(
      loadPromptRefImages({
        prompt: "just text",
        workspaceDir: "/workspace",
      }),
    ).resolves.toEqual([]);

    expect(mocks.loadImageFromRef).not.toHaveBeenCalled();
    expect(mocks.sanitizeImageBlocks).not.toHaveBeenCalled();
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

    mocks.loadImageFromRef.mockResolvedValueOnce(loadedImage);
    mocks.sanitizeImageBlocks.mockResolvedValueOnce({ images: [sanitizedImage], dropped: 0 });

    const result = await loadPromptRefImages({
      prompt: "Look at /tmp/photo.png",
      workspaceDir: "/workspace",
      workspaceOnly: true,
      sandbox,
    });

    const [ref, workspaceDir, options] = mocks.loadImageFromRef.mock.calls[0] ?? [];
    expect(ref).toMatchObject({ resolved: "/tmp/photo.png", type: "path" });
    expect(workspaceDir).toBe("/workspace");
    expect(options).toEqual({
      maxBytes: MAX_IMAGE_BYTES,
      workspaceOnly: true,
      sandbox,
    });
    expect(mocks.sanitizeImageBlocks).toHaveBeenCalledWith([loadedImage], "prompt:images", {
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

    mocks.loadImageFromRef.mockResolvedValueOnce(loadedImage).mockResolvedValueOnce(null);

    const result = await loadPromptRefImages({
      prompt: "Compare /tmp/a.png with /tmp/a.png and /tmp/b.png",
      workspaceDir: "/workspace",
    });

    expect(mocks.loadImageFromRef).toHaveBeenCalledTimes(2);
    expect(
      mocks.loadImageFromRef.mock.calls.map(
        (call: unknown[]) => (call[0] as { resolved?: string } | undefined)?.resolved,
      ),
    ).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    expect(mocks.sanitizeImageBlocks).toHaveBeenCalledWith([loadedImage], "prompt:images", {
      maxBytes: MAX_IMAGE_BYTES,
    });
    expect(result).toEqual([loadedImage]);
  });
});
