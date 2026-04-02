import type { ImageContent } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "../media/constants.js";
import { buildCliArgs, loadPromptRefImages, resolveCliRunQueueKey } from "./cli-runner/helpers.js";
import * as promptImageUtils from "./pi-embedded-runner/run/images.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";
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

  it("strips the internal cache boundary from CLI system prompt args", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "claude",
          systemPromptArg: "--append-system-prompt",
        },
        baseArgs: ["-p"],
        modelId: "claude-sonnet-4-6",
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        useResume: false,
      }),
    ).toEqual(["-p", "--append-system-prompt", "Stable prefix\nDynamic suffix"]);
  });
  
  it("places the prompt immediately after Claude CLI -p", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "claude",
          promptFlag: "-p",
        },
        baseArgs: [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "bypassPermissions",
        ],
        modelId: "claude-opus-4-6",
        promptArg: "user prompt",
        useResume: false,
      }),
    ).toEqual([
      "-p",
      "user prompt",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("places the prompt immediately after --prompt for generic prompt-flag backends", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "gemini",
          promptFlag: "--prompt",
        },
        baseArgs: ["--resume", "sid-1", "--prompt", "--output-format", "json"],
        modelId: "gemini-3.1-pro-preview",
        promptArg: "resume prompt",
        useResume: true,
      }),
    ).toEqual(["--resume", "sid-1", "--prompt", "resume prompt", "--output-format", "json"]);
  });

  it("appends the prompt when no prompt flag exists in base args", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "codex",
          modelArg: "--model",
        },
        baseArgs: ["exec", "--json"],
        modelId: "gpt-5.4",
        promptArg: "user prompt",
        useResume: false,
      }),
    ).toEqual(["exec", "--json", "--model", "gpt-5.4", "user prompt"]);
  });
});

describe("resolveCliRunQueueKey", () => {
  it("scopes Claude CLI serialization to the workspace for fresh runs", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        serialize: true,
        runId: "run-1",
        workspaceDir: "/tmp/project-a",
      }),
    ).toBe("claude-cli:workspace:/tmp/project-a");
  });

  it("scopes Claude CLI serialization to the resumed CLI session id", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        serialize: true,
        runId: "run-2",
        workspaceDir: "/tmp/project-a",
        cliSessionId: "claude-session-123",
      }),
    ).toBe("claude-cli:session:claude-session-123");
  });

  it("keeps non-Claude backends on the provider lane when serialized", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "codex-cli",
        serialize: true,
        runId: "run-3",
        workspaceDir: "/tmp/project-a",
        cliSessionId: "thread-123",
      }),
    ).toBe("codex-cli");
  });

  it("disables serialization when serialize=false", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        serialize: false,
        runId: "run-4",
        workspaceDir: "/tmp/project-a",
      }),
    ).toBe("claude-cli:run-4");
  });
});
