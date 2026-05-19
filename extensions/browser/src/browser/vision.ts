// Vision fallback for the browser screenshot tool.
//
// When `tools.browser.models[]` is configured, the browser screenshot action
// runs the captured image through the configured vision model(s) and returns
// the description as text so text-only main models can read what the browser
// sees. When the config is absent, screenshots flow through the existing
// `imageResultFromFile` path unchanged so multimodal main models keep their
// direct image input.
//
// This module is intentionally narrow: it only handles the screenshot scope,
// not the broader media-understanding tool surface. It reuses
// `describeImageFileWithModel` from the plugin SDK so provider/auth/transport
// behaviour stays aligned with the existing image understanding tool.

import { stat } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { describeImageFileWithModel as DescribeImageFileWithModelFn } from "openclaw/plugin-sdk/media-understanding-runtime";

const log = createSubsystemLogger("extensions/browser/vision");

// Minimal local shape of `tools.browser` (a media-understanding config) that
// avoids depending on internal core types. Mirrors the relevant subset of
// `MediaUnderstandingConfig` / `MediaUnderstandingModelConfig` from
// `src/config/types.tools.ts`. Keep field names aligned.
type BrowserVisionModelEntry = {
  provider?: string;
  model?: string;
  prompt?: string;
  maxChars?: number;
  maxBytes?: number;
  timeoutSeconds?: number;
  type?: "provider" | "cli";
  profile?: string;
  preferredProfile?: string;
};

type BrowserVisionConfig = {
  enabled?: boolean;
  prompt?: string;
  maxChars?: number;
  maxBytes?: number;
  timeoutSeconds?: number;
  models?: BrowserVisionModelEntry[];
};

export const DEFAULT_BROWSER_VISION_PROMPT =
  "Describe what is visible in this browser screenshot. Capture page layout, headings, primary content blocks, visible text, and any notable interactive elements so a text-only assistant can reason about the page.";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 4096;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export type BrowserVisionAttempt = {
  provider: string;
  model: string;
  error: string;
};

export type BrowserVisionResult = {
  text: string;
  provider: string;
  model: string;
  attempts: BrowserVisionAttempt[];
};

export type BrowserVisionContext = {
  cfg: OpenClawConfig | undefined;
  filePath: string;
  /** Optional canonical media URL (defaults to filePath). */
  mediaUrl?: string;
  agentDir?: string;
  workspaceDir?: string;
};

export type BrowserVisionDeps = {
  describeImageFileWithModel: typeof DescribeImageFileWithModelFn;
};

/**
 * Returns true when `browser.models` contains at least one entry with a
 * resolvable provider+model. Other vision configuration is optional.
 */
export function isBrowserVisionEnabled(cfg: OpenClawConfig | undefined): boolean {
  const candidates = collectVisionCandidates(getBrowserVisionConfig(cfg));
  return candidates.length > 0;
}

export function getBrowserVisionConfig(
  cfg: OpenClawConfig | undefined,
): BrowserVisionConfig | undefined {
  const browser = cfg?.browser;
  if (!browser?.models?.length) {
    return undefined;
  }
  return {
    enabled: browser.visionEnabled,
    models: browser.models,
    prompt: browser.visionPrompt,
    maxChars: browser.visionMaxChars,
    maxBytes: browser.visionMaxBytes,
    timeoutSeconds: browser.visionTimeoutSeconds,
  };
}

type ResolvedVisionCandidate = {
  provider: string;
  model: string;
  prompt?: string;
  maxChars?: number;
  maxBytes?: number;
  timeoutMs?: number;
  profile?: string;
  preferredProfile?: string;
};

function collectVisionCandidates(
  visionCfg: BrowserVisionConfig | undefined,
): ResolvedVisionCandidate[] {
  if (!visionCfg) {
    return [];
  }
  if (visionCfg.enabled === false) {
    return [];
  }
  const entries = Array.isArray(visionCfg.models) ? visionCfg.models : [];
  const out: ResolvedVisionCandidate[] = [];
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    if (entry.type === "cli") {
      // CLI-style media-understanding entries are not supported by the
      // browser tool; skip them rather than throwing so operators can share
      // model lists with the image understanding tool.
      continue;
    }
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    if (!provider || !model) {
      continue;
    }
    out.push({
      provider,
      model,
      prompt: typeof entry.prompt === "string" ? entry.prompt : undefined,
      maxChars: typeof entry.maxChars === "number" ? entry.maxChars : undefined,
      maxBytes: typeof entry.maxBytes === "number" ? entry.maxBytes : undefined,
      timeoutMs:
        typeof entry.timeoutSeconds === "number" && Number.isFinite(entry.timeoutSeconds)
          ? Math.max(1, Math.floor(entry.timeoutSeconds * 1000))
          : undefined,
      profile: typeof entry.profile === "string" ? entry.profile : undefined,
      preferredProfile:
        typeof entry.preferredProfile === "string" ? entry.preferredProfile : undefined,
    });
  }
  return out;
}

function resolveDefaultPrompt(visionCfg: BrowserVisionConfig | undefined): string {
  const explicit = visionCfg?.prompt;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }
  return DEFAULT_BROWSER_VISION_PROMPT;
}

function resolveDefaultTimeoutMs(visionCfg: BrowserVisionConfig | undefined): number {
  const seconds = visionCfg?.timeoutSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return Math.floor(seconds * 1000);
  }
  return DEFAULT_TIMEOUT_MS;
}

function resolveDefaultMaxChars(visionCfg: BrowserVisionConfig | undefined): number {
  const cap = visionCfg?.maxChars;
  if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
    return Math.floor(cap);
  }
  return DEFAULT_MAX_CHARS;
}

function resolveDefaultMaxBytes(visionCfg: BrowserVisionConfig | undefined): number {
  const cap = visionCfg?.maxBytes;
  if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
    return Math.floor(cap);
  }
  return DEFAULT_MAX_BYTES;
}

function truncateForMaxChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  // Reserve room for a trailing marker so the agent can tell the description
  // was clipped rather than naturally short.
  const marker = "\n[truncated]";
  const head = Math.max(0, maxChars - marker.length);
  return text.slice(0, head) + marker;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Runs the configured `tools.browser.models[]` against the captured screenshot
 * file, returning the first successful description. Throws an aggregate error
 * if every candidate fails. Callers must call `isBrowserVisionEnabled`
 * first so the "no models configured" case stays a hard "vision not enabled"
 * branch rather than a runtime failure.
 */
export async function describeBrowserImageWithVision(
  ctx: BrowserVisionContext,
  deps: BrowserVisionDeps,
): Promise<BrowserVisionResult> {
  const visionCfg = getBrowserVisionConfig(ctx.cfg);
  const candidates = collectVisionCandidates(visionCfg);
  if (candidates.length === 0) {
    // Guard: callers should have checked isBrowserVisionEnabled
    // already. Surface a clear error rather than silently returning empty
    // text so misuse is loud.
    throw new Error("tools.browser.models is not configured");
  }
  const defaultPrompt = resolveDefaultPrompt(visionCfg);
  const defaultTimeoutMs = resolveDefaultTimeoutMs(visionCfg);
  const defaultMaxChars = resolveDefaultMaxChars(visionCfg);
  const defaultMaxBytes = resolveDefaultMaxBytes(visionCfg);

  // Enforce maxBytes before sending the file to the vision provider.
  // describeImageFileWithModel reads the full file internally, so we stat
  // upfront and skip oversized files rather than streaming a multi-hundred-MB
  // buffer to the provider API.
  let fileSizeBytes: number | undefined;
  try {
    fileSizeBytes = (await stat(ctx.filePath)).size;
  } catch {
    // If stat fails the file may be gone; let describeImageFileWithModel
    // surface the real I/O error below.
  }

  const attempts: BrowserVisionAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const prompt = candidate.prompt ?? defaultPrompt;
    const timeoutMs = candidate.timeoutMs ?? defaultTimeoutMs;
    const maxChars = candidate.maxChars ?? defaultMaxChars;
    const maxBytes = candidate.maxBytes ?? defaultMaxBytes;

    if (fileSizeBytes !== undefined && fileSizeBytes > maxBytes) {
      const reason = `file size ${fileSizeBytes} exceeds maxBytes ${maxBytes}`;
      attempts.push({ provider: candidate.provider, model: candidate.model, error: reason });
      lastError = new Error(reason);
      log.warn(`[browser/vision] ${candidate.provider}/${candidate.model} skipped: ${reason}`);
      continue;
    }

    // Only forward `mediaUrl` when it points to an HTTP(S) resource; the
    // upstream describeImageFileWithModel treats any provided mediaUrl as a
    // remote ref to fetch, which fails for local screenshot paths like
    // `/Users/.../media/browser/<id>.jpg`. When omitted, the runtime falls
    // back to reading `filePath` directly from disk.
    const mediaUrlForRemoteFetch =
      typeof ctx.mediaUrl === "string" && /^https?:\/\//i.test(ctx.mediaUrl)
        ? ctx.mediaUrl
        : undefined;
    try {
      const described = await deps.describeImageFileWithModel({
        filePath: ctx.filePath,
        ...(mediaUrlForRemoteFetch ? { mediaUrl: mediaUrlForRemoteFetch } : {}),
        cfg: ctx.cfg ?? ({} as OpenClawConfig),
        agentDir: ctx.agentDir,
        ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
        provider: candidate.provider,
        model: candidate.model,
        prompt,
        timeoutMs,
        ...(candidate.profile ? { profile: candidate.profile } : {}),
        ...(candidate.preferredProfile ? { preferredProfile: candidate.preferredProfile } : {}),
      });
      const rawText = typeof described?.text === "string" ? described.text : "";
      const trimmed = rawText.trim();
      if (!trimmed) {
        const reason = "empty description";
        attempts.push({ provider: candidate.provider, model: candidate.model, error: reason });
        lastError = new Error(reason);
        continue;
      }
      const description = truncateForMaxChars(trimmed, maxChars);
      log.info(
        `[browser/vision] described screenshot via ${candidate.provider}/${described?.model ?? candidate.model} (chars=${description.length})`,
      );
      return {
        text: description,
        provider: candidate.provider,
        model: described?.model ?? candidate.model,
        attempts,
      };
    } catch (err) {
      const reason = errorMessage(err);
      attempts.push({ provider: candidate.provider, model: candidate.model, error: reason });
      lastError = err;
      log.warn(
        `[browser/vision] candidate ${candidate.provider}/${candidate.model} failed: ${reason}`,
      );
    }
  }

  const aggregate =
    attempts.map((a) => `${a.provider}/${a.model}: ${a.error}`).join("; ") ||
    errorMessage(lastError);
  throw new Error(`browser screenshot vision failed: ${aggregate}`);
}
