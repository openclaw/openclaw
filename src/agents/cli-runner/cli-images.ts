/**
 * CLI image payload helpers: path resolution, cache sweeping, size validation,
 * and prompt/image payload preparation for CLI backend runs.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { extensionForMime } from "@openclaw/media-core/mime";
import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { privateFileStore } from "../../infra/private-file-store.js";
import { tempWorkspace } from "../../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { ImageContent } from "../../llm/types.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import {
  detectAndLoadPromptImages,
  detectImageReferences,
  loadImageFromRef,
} from "../embedded-agent-runner/run/images.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import { sanitizeImageBlocks } from "../tool-images.js";
import { cliBackendLog } from "./log.js";

const CLI_IMAGE_SWEEP_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const sweptCliImageRoots = new Set<string>();

/**
 * Validates base64 decoded size against a byte budget without decoding.
 * Returns an Error instead of throwing so the caller decides the strategy.
 */
function validateBase64SizeLimit(base64: string, maxBytes: number): Error | undefined {
  const estimated = estimateBase64DecodedBytes(base64);
  if (estimated > maxBytes) {
    return new Error(`Base64 payload exceeds size limit: ${estimated} bytes > ${maxBytes} bytes`);
  }
  return undefined;
}

function resolveCliImagePath(image: ImageContent): string {
  const ext = extensionForMime(image.mimeType) ?? ".bin";
  const digest = crypto
    .createHash("sha256")
    .update(image.mimeType)
    .update("\0")
    .update(image.data)
    .digest("hex");
  return path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images", `${digest}${ext}`);
}

function resolveCliImageRoot(params: { backend: CliBackendConfig; workspaceDir: string }): string {
  if (params.backend.imagePathScope === "workspace") {
    return path.join(params.workspaceDir, ".openclaw-cli-images");
  }
  return path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images");
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

async function sweepCliImageRoot(imageRoot: string): Promise<void> {
  if (sweptCliImageRoots.has(imageRoot)) {
    return;
  }
  sweptCliImageRoots.add(imageRoot);
  try {
    const cutoffMs = Date.now() - CLI_IMAGE_SWEEP_TTL_MS;
    const entries = await fs.readdir(imageRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const entryPath = path.join(imageRoot, entry.name);
      const stat = await fs.stat(entryPath).catch((error: unknown) => {
        if (isFileNotFoundError(error)) {
          return undefined;
        }
        throw error;
      });
      if (!stat) {
        continue;
      }
      if (stat.mtimeMs >= cutoffMs) {
        continue;
      }
      try {
        await fs.rm(entryPath, { force: true });
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          throw error;
        }
      }
    }
  } catch (error) {
    cliBackendLog.debug(`cli image cache sweep failed: ${String(error)}`);
  }
}

function appendImagePathsToPrompt(prompt: string, paths: string[], prefix = ""): string {
  if (!paths.length) {
    return prompt;
  }
  const trimmed = prompt.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  return `${trimmed}${separator}${paths.map((entry) => `${prefix}${entry}`).join("\n")}`;
}

/** Loads and sanitizes image references found in prompt text. */
async function loadPromptRefImages(params: {
  prompt: string;
  workspaceDir: string;
  maxBytes?: number;
  workspaceOnly?: boolean;
  sandbox?: { root: string; bridge: SandboxFsBridge };
}): Promise<ImageContent[]> {
  const refs = detectImageReferences(params.prompt);
  if (refs.length === 0) {
    return [];
  }

  const maxBytes = params.maxBytes ?? MAX_IMAGE_BYTES;
  const seen = new Set<string>();
  const images: ImageContent[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.resolved}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const image = await loadImageFromRef(ref, params.workspaceDir, {
      maxBytes,
      workspaceOnly: params.workspaceOnly,
      sandbox: params.sandbox,
    });
    if (image) {
      images.push(image);
    }
  }

  const { images: sanitizedImages } = await sanitizeImageBlocks(images, "prompt:images", {
    maxBytes,
  });
  return sanitizedImages;
}

/** Writes CLI image payloads to private paths and returns their file paths. */
async function writeCliImages(params: {
  backend: CliBackendConfig;
  workspaceDir: string;
  images: ImageContent[];
  maxBytes?: number;
}): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const maxBytes = params.maxBytes ?? MAX_IMAGE_BYTES;
  const imageRoot = resolveCliImageRoot({
    backend: params.backend,
    workspaceDir: params.workspaceDir,
  });
  await fs.mkdir(imageRoot, { recursive: true, mode: 0o700 });
  await sweepCliImageRoot(imageRoot);
  const store = privateFileStore(imageRoot);
  const paths: string[] = [];
  for (const image of params.images) {
    const fileName = path.basename(resolveCliImagePath(image));
    const sizeError = validateBase64SizeLimit(image.data, maxBytes);
    if (sizeError) {
      throw sizeError;
    }
    const buffer = Buffer.from(image.data, "base64");
    await store.writeText(fileName, buffer);
    paths.push(store.path(fileName));
  }
  // Keep content-addressed image paths stable across Claude CLI runs so prompt
  // text and argv don't churn on every turn with fresh temp-dir suffixes.
  const cleanup = async () => {};
  return { paths, cleanup };
}

/** Writes a temporary system prompt file when the backend needs file-based prompts. */
export async function writeCliSystemPromptFile(params: {
  backend: CliBackendConfig;
  systemPrompt: string;
}): Promise<{ filePath?: string; cleanup: () => Promise<void> }> {
  if (
    !params.backend.systemPromptFileArg?.trim() &&
    !params.backend.systemPromptFileConfigKey?.trim()
  ) {
    return { cleanup: async () => {} };
  }
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-cli-system-prompt-",
  });
  const filePath = await workspace.write(
    "system-prompt.md",
    stripSystemPromptCacheBoundary(params.systemPrompt),
  );
  return {
    filePath,
    cleanup: async () => await workspace.cleanup(),
  };
}

/** Prepares prompt text and image paths for a CLI backend run. */
export async function prepareCliPromptImagePayload(params: {
  backend: CliBackendConfig;
  prompt: string;
  imagePrompt?: string;
  workspaceDir: string;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  contextEngineConfig?: OpenClawConfig;
}): Promise<{
  prompt: string;
  imagePaths?: string[];
  cleanupImages?: () => Promise<void>;
}> {
  const maxBytes = resolveGeneratedMediaMaxBytes(params.contextEngineConfig, "image");
  let prompt = params.prompt;
  const resolvedImages =
    params.imagePrompt !== undefined
      ? (
          await detectAndLoadPromptImages({
            prompt: params.imagePrompt,
            workspaceDir: params.workspaceDir,
            model: { input: ["text", "image"] },
            existingImages: params.images,
            imageOrder: params.imageOrder,
            maxBytes: MAX_IMAGE_BYTES,
          })
        ).images
      : params.images && params.images.length > 0
        ? params.images
        : await loadPromptRefImages({ prompt, workspaceDir: params.workspaceDir });
  if (resolvedImages.length === 0) {
    return { prompt };
  }
  const imagePayload = await writeCliImages({
    backend: params.backend,
    workspaceDir: params.workspaceDir,
    images: resolvedImages,
    maxBytes,
  });
  const imagePaths = imagePayload.paths;
  if (
    !params.backend.imageArg ||
    params.backend.input === "stdin" ||
    params.backend.imageArg === "@"
  ) {
    prompt = appendImagePathsToPrompt(
      prompt,
      imagePaths,
      params.backend.imageArg === "@" ? "@" : "",
    );
  }
  return {
    prompt,
    imagePaths,
    cleanupImages: imagePayload.cleanup,
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cliImagesTestApi")] = {
    writeCliImages,
  };
}
