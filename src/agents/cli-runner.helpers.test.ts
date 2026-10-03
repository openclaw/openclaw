/** Tests CLI runner prompt/image/system-prompt helper utilities. */
import fs from "node:fs/promises";
import path from "node:path";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import type { ImageContent } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import { escapeRegExp } from "../shared/regexp.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  formatCliImageTurnContext,
  hashCliImageTurnEntryId,
  readCliImageTurnContext,
} from "./cli-image-turn-correlation.js";
import {
  buildCliArgs,
  prepareCliPromptImagePayload,
  resolveCliRunQueueKey,
  writeCliSystemPromptFile,
} from "./cli-runner/helpers.js";
import * as promptImageUtils from "./embedded-agent-runner/run/images.js";
import * as toolImages from "./tool-images.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function imageWorkspace() {
  return tempDirs.make("openclaw-cli-images-", resolvePreferredOpenClawTmpDir());
}

function pngImage(data: string | Buffer): ImageContent {
  return {
    type: "image",
    data: typeof data === "string" ? data : data.toString("base64"),
    mimeType: "image/png",
  };
}

describe("prepareCliPromptImagePayload prompt references", () => {
  beforeEach(() => {
    // Restore spies because these helpers use real modules with per-test mocks.
    vi.restoreAllMocks();
  });

  it("does not reload OpenClaw CLI image cache paths from prior prompt text", async () => {
    const detectAndLoadPromptImagesSpy = vi.spyOn(promptImageUtils, "detectAndLoadPromptImages");
    const sanitizeImageBlocksSpy = vi.spyOn(toolImages, "sanitizeImageBlocks");

    await expect(
      prepareCliPromptImagePayload({
        backend: { command: "gemini", imagePathScope: "workspace" },
        prompt:
          'Called the Read tool with {"file_path":"/workspace/.openclaw-cli-images/stale.png"}',
        workspaceDir: "/workspace",
      }),
    ).resolves.toStrictEqual({
      prompt: 'Called the Read tool with {"file_path":"/workspace/.openclaw-cli-images/stale.png"}',
    });

    // Cached image paths are generated output, not fresh user references.
    expect(detectAndLoadPromptImagesSpy).not.toHaveBeenCalled();
    expect(sanitizeImageBlocksSpy).not.toHaveBeenCalled();
  });

  it("hydrates structured media from the active agent workspace without widening sibling access", async () => {
    const stateDir = tempDirs.make("openclaw-cli-agent-image-");
    const workspaceDir = path.join(stateDir, "workspace-arthur");
    const siblingWorkspaceDir = path.join(stateDir, "workspace-merlin");
    const imagePath = path.join(workspaceDir, "media", "inbound", "photo.png");
    const siblingImagePath = path.join(siblingWorkspaceDir, "media", "inbound", "photo.png");
    const image = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.mkdir(path.dirname(siblingImagePath), { recursive: true });
    await fs.writeFile(imagePath, image);
    await fs.writeFile(siblingImagePath, image);
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const config = {
      agents: {
        entries: {
          arthur: { default: true, workspace: workspaceDir },
          merlin: { workspace: siblingWorkspaceDir },
        },
      },
    };

    try {
      const localRoots = getAgentScopedMediaLocalRoots(config, "arthur");
      const prepared = await prepareCliPromptImagePayload({
        backend: { command: "claude", input: "stdin" },
        prompt: "describe the attachment",
        workspaceDir,
        localRoots,
        media: [{ path: imagePath, contentType: "image/png" }],
      });

      expect(prepared.imagePaths).toHaveLength(1);
      await expect(fs.readFile(prepared.imagePaths?.[0] ?? "")).resolves.toEqual(image);
      await expect(
        prepareCliPromptImagePayload({
          backend: { command: "claude", input: "stdin" },
          prompt: "describe the attachment",
          workspaceDir,
          localRoots,
          media: [{ path: siblingImagePath, contentType: "image/png" }],
        }),
      ).rejects.toThrow("failed to hydrate 1 structured image attachment");
    } finally {
      envSnapshot.restore();
    }
  });

  it("dedupes repeated refs and skips failed loads before sanitizing", async () => {
    const workspaceDir = imageWorkspace();
    const imagePath = path.join(workspaceDir, "a.png");
    await fs.writeFile(imagePath, createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 }));
    const result = await prepareCliPromptImagePayload({
      backend: { command: "gemini", imagePathScope: "workspace" },
      prompt: `Compare ${imagePath} with ${imagePath} and ${path.join(workspaceDir, "missing.png")}`,
      workspaceDir,
    });

    expect(result.imagePaths).toHaveLength(1);
  });

  it("does not hydrate media suppressed during current-turn admission", async () => {
    await expect(
      prepareCliPromptImagePayload({
        backend: { command: "claude" },
        prompt: "describe the attachment",
        imagePrompt: "describe the attachment",
        workspaceDir: "/workspace",
        images: [],
        imageOrder: [],
        mediaImageLayout: { slots: [], suppressedFactIndexes: [0] },
        media: [
          {
            path: "/openclaw-test-missing/current.png",
            contentType: "image/png",
            hydrationSuppressed: true,
          },
        ],
      }),
    ).resolves.toEqual({ prompt: "describe the attachment" });
  });

  it("delivers readable structured images when an unresolved attachment is hydration-suppressed", async () => {
    const workspaceDir = imageWorkspace();
    const imagePath = path.join(workspaceDir, "present.png");
    const image = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    await fs.writeFile(imagePath, image);
    const result = await prepareCliPromptImagePayload({
      backend: { command: "codex" },
      prompt: "describe the attachments",
      workspaceDir,
      images: [pngImage(image)],
      imageOrder: ["inline"],
      media: [
        { path: imagePath, contentType: "image/png" },
        {
          path: path.join(workspaceDir, "missing.png"),
          contentType: "image/png",
          hydrationSuppressed: true,
        },
      ],
    });

    expect(result.imagePaths).toHaveLength(1);
  });

  it("surfaces inline sanitization failure when a preceding image fact is suppressed", async () => {
    await expect(
      prepareCliPromptImagePayload({
        backend: { command: "codex" },
        prompt: "already described",
        workspaceDir: "/tmp",
        images: [pngImage("%%%")],
        imageOrder: ["inline"],
        media: [
          {
            path: "/tmp/described-missing.png",
            contentType: "image/png",
            hydrationSuppressed: true,
          },
          { path: "/tmp/inline.png", contentType: "image/png" },
        ],
      }),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });
});

describe("writeCliImages", () => {
  it("uses stable hashed file paths so repeated image hydration reuses the same path", async () => {
    const image = pngImage("c29tZS1pbWFnZQ==");
    const params = {
      backend: { command: "codex" },
      prompt: "",
      workspaceDir: imageWorkspace(),
      images: [image],
    };
    const first = await prepareCliPromptImagePayload(params);
    const second = await prepareCliPromptImagePayload(params);

    try {
      expect(first.imagePaths).toStrictEqual([
        expect.stringMatching(
          new RegExp(
            `^${escapeRegExp(`${resolvePreferredOpenClawTmpDir()}/openclaw-cli-images/`)}.*\\.png$`,
          ),
        ),
      ]);
      expect(second.imagePaths).toEqual(first.imagePaths);
      await expect(
        fs.readFile(expectDefined(first.imagePaths?.[0], "first image path test invariant")),
      ).resolves.toEqual(Buffer.from(image.data, "base64"));
    } finally {
      await fs.rm(expectDefined(first.imagePaths?.[0], "first image path test invariant"), {
        force: true,
      });
    }
  });

  it("carries exact image-turn correlation beside Claude prompt paths", async () => {
    const turnKey = hashCliImageTurnEntryId("transcript-entry-1");
    const prepared = await prepareCliPromptImagePayload({
      backend: { command: "claude", imageArg: "@" },
      prompt: "describe this",
      workspaceDir: "/workspace",
      images: [pngImage("aW1hZ2U=")],
      imageTurnKey: turnKey,
    });

    try {
      expect(readCliImageTurnContext(prepared.prompt)).toBe(turnKey);
      expect(stripInboundMetadata(prepared.prompt)).not.toContain(turnKey);
      expect(stripInboundMetadata(prepared.prompt)).toContain(
        `@${expectDefined(prepared.imagePaths?.[0], "correlated image path")}`,
      );
    } finally {
      await fs.rm(expectDefined(prepared.imagePaths?.[0], "correlated image path"), {
        force: true,
      });
    }
  });

  it("rejects conflicting or malformed image-turn correlation", () => {
    const first = hashCliImageTurnEntryId("transcript-entry-1");
    const second = hashCliImageTurnEntryId("transcript-entry-2");

    expect(
      readCliImageTurnContext(
        `${formatCliImageTurnContext(first)}\n\n${formatCliImageTurnContext(second)}`,
      ),
    ).toBeUndefined();
    expect(readCliImageTurnContext(formatCliImageTurnContext("not-a-key"))).toBeUndefined();
  });

  it("sweeps stale workspace-scoped CLI image files", async () => {
    const workspaceDir = imageWorkspace();
    const imageRoot = path.join(workspaceDir, ".openclaw-cli-images");
    const stalePath = path.join(imageRoot, "stale.png");
    const freshPath = path.join(imageRoot, "fresh.png");
    const image = pngImage("bmV3LWltYWdl");

    await fs.mkdir(imageRoot, { recursive: true });
    await fs.writeFile(stalePath, "stale");
    await fs.writeFile(freshPath, "fresh");
    const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    await fs.utimes(stalePath, staleTime, staleTime);

    const written = await prepareCliPromptImagePayload({
      backend: { command: "gemini", imagePathScope: "workspace" },
      prompt: "",
      workspaceDir,
      images: [image],
    });

    await expect(fs.access(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(freshPath, "utf-8")).resolves.toBe("fresh");
    await expect(
      fs.readFile(expectDefined(written.imagePaths?.[0], "written image path test invariant")),
    ).resolves.toEqual(Buffer.from(image.data, "base64"));
  });

  it("appends Gemini prompt refs with @-prefixed image paths", async () => {
    const tempDir = imageWorkspace();
    const explicitImage = pngImage("c29tZS1leHBsaWNpdC1pbWFnZQ==");

    const prepared = await prepareCliPromptImagePayload({
      backend: {
        command: "gemini",
        imageArg: "@",
        imagePathScope: "workspace",
        input: "arg",
      },
      prompt: "What is in this image?",
      workspaceDir: tempDir,
      images: [explicitImage],
    });

    expect(prepared.prompt).toContain("\n\n@");
    expect(prepared.prompt).toContain(prepared.imagePaths?.[0] ?? "");
    expect(prepared.prompt.trimEnd().endsWith(`@${prepared.imagePaths?.[0] ?? ""}`)).toBe(true);
    expect(prepared.imagePaths?.[0]?.startsWith(path.join(tempDir, ".openclaw-cli-images"))).toBe(
      true,
    );

    const argv = buildCliArgs({
      backend: {
        command: "gemini",
        imageArg: "@",
        imagePathScope: "workspace",
      },
      baseArgs: ["--output-format", "json", "--prompt", "{prompt}"],
      modelId: "gemini-3.1-pro-preview",
      promptArg: prepared.prompt,
      imagePaths: prepared.imagePaths,
      useResume: false,
    });

    expect(argv).toEqual(["--output-format", "json", "--prompt", prepared.prompt]);
  });

  it("prefers explicit images over prompt refs through the helper seams", async () => {
    const tempDir = imageWorkspace();
    const sourceImage = path.join(tempDir, "ignored-prompt-image.png");
    await fs.writeFile(sourceImage, createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 }));
    const explicitImage = pngImage("c29tZS1leHBsaWNpdC1pbWFnZQ==");

    const prepared = await prepareCliPromptImagePayload({
      backend: {
        command: "codex",
        imageArg: "--image",
        imageMode: "repeat",
        input: "arg",
      },
      prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
      workspaceDir: tempDir,
      images: [explicitImage],
    });
    const argv = buildCliArgs({
      backend: {
        command: "codex",
        imageArg: "--image",
        imageMode: "repeat",
      },
      baseArgs: ["exec", "--json"],
      modelId: "gpt-5.4",
      imagePaths: prepared.imagePaths,
      useResume: false,
    });

    expect(argv.reduce((count, arg) => count + (arg === "--image" ? 1 : 0), 0)).toBe(1);
    expect(argv[argv.indexOf("--image") + 1]).toContain("openclaw-cli-images");
    await expect(fs.readFile(prepared.imagePaths?.[0] ?? "")).resolves.toEqual(
      Buffer.from(explicitImage.data, "base64"),
    );
  });

  it("merges inline payloads with offloaded refs in attachment order", async () => {
    const stateDir = tempDirs.make("openclaw-cli-mixed-images-");
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "offloaded.png";
    const historyImagePath = path.join(workspaceDir, "history.png");
    const offloadedImage = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
    const inlineImage = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    const historyImage = createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, mediaId), offloadedImage);
    await fs.writeFile(historyImagePath, historyImage);
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const currentTurn = `compare these\n[media attached: media://inbound/${mediaId}]`;

    try {
      const prepared = await prepareCliPromptImagePayload({
        backend: {
          command: "codex",
          imageArg: "--image",
          imageMode: "repeat",
          input: "arg",
        },
        prompt: `[Earlier history: ${historyImagePath}]\n\n[Retry after failure]\n\n${currentTurn}`,
        imagePrompt: currentTurn,
        workspaceDir,
        images: [pngImage(inlineImage)],
        imageOrder: ["offloaded", "inline"],
        mediaImageLayout: {
          slots: [{ kind: "offloaded", factIndex: 0 }, { kind: "inline" }],
          suppressedFactIndexes: [],
        },
        media: [{ url: `media://inbound/${mediaId}`, contentType: "image/png" }],
      });

      expect(prepared.imagePaths).toHaveLength(2);
      await expect(fs.readFile(prepared.imagePaths?.[0] ?? "")).resolves.toEqual(offloadedImage);
      await expect(fs.readFile(prepared.imagePaths?.[1] ?? "")).resolves.toEqual(inlineImage);
    } finally {
      envSnapshot.restore();
    }
  });
});

describe("writeCliSystemPromptFile", () => {
  it("writes stripped system prompts to a private temp file", async () => {
    const written = await writeCliSystemPromptFile({
      backend: {
        command: "codex",
        systemPromptFileConfigKey: "model_instructions_file",
      },
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
    });

    try {
      expect(written.filePath).toContain("openclaw-cli-system-prompt-");
      await expect(fs.readFile(written.filePath ?? "", "utf-8")).resolves.toBe(
        "Stable prefix\nDynamic suffix",
      );
    } finally {
      await written.cleanup();
    }
    let err: unknown;
    try {
      await fs.access(written.filePath ?? "");
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});

describe("resolveCliRunQueueKey", () => {
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

  it("keeps third-party live sessions serialized on their exact owner even when serialize=false", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "acme-cli",
        liveSession: "claude-stdio",
        serialize: false,
        runId: "run-third-party-live",
        workspaceDir: "/tmp/project-a",
        ownerKey: "third-party-owner",
      }),
    ).toBe("acme-cli:owner:third-party-owner");
  });
});
