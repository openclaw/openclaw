import type { ImageContent } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "../media/constants.js";
import { buildCliArgs, loadPromptRefImages } from "./cli-runner/helpers.js";
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

		const [ref, workspaceDir, options] =
			loadImageFromRefSpy.mock.calls[0] ?? [];
		expect(ref).toMatchObject({ resolved: "/tmp/photo.png", type: "path" });
		expect(workspaceDir).toBe("/workspace");
		expect(options).toEqual({
			maxBytes: MAX_IMAGE_BYTES,
			workspaceOnly: true,
			sandbox,
		});
		expect(sanitizeImageBlocksSpy).toHaveBeenCalledWith(
			[loadedImage],
			"prompt:images",
			{
				maxBytes: MAX_IMAGE_BYTES,
			},
		);
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
		expect(sanitizeImageBlocksSpy).toHaveBeenCalledWith(
			[loadedImage],
			"prompt:images",
			{
				maxBytes: MAX_IMAGE_BYTES,
			},
		);
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
