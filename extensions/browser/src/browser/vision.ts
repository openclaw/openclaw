/**
 * Browser screenshot description helpers built on the shared media image
 * understanding contract. No browser-specific model registry lives here.
 */

import { readFile } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

/** Default prompt for turning browser screenshots into text-only page context. */
const DEFAULT_BROWSER_SCREENSHOT_DESCRIPTION_PROMPT =
  "Describe what is visible in this browser screenshot. Capture page layout, headings, primary content blocks, visible text, and notable interactive elements so a text-only assistant can reason about the page.";

/** Input context for browser screenshot image understanding. */
type BrowserScreenshotDescriptionContext = {
  cfg: OpenClawConfig;
  filePath: string;
  agentDir?: string;
  workspaceDir?: string;
  agentId?: string;
  activeModel?: {
    provider?: string;
    model?: string;
  };
  mediaScope?: {
    sessionKey?: string;
    channel?: string;
    chatType?: string;
  };
  imageSanitization?: {
    maxDimensionPx?: number;
  };
};

/** Result returned from browser screenshot description. */
type BrowserScreenshotDescriptionResult = {
  text: string;
  provider?: string;
  model?: string;
  decision?: unknown;
};

function normalizeActiveModel(
  activeModel: BrowserScreenshotDescriptionContext["activeModel"],
): { provider: string; model?: string } | undefined {
  const provider = activeModel?.provider?.trim();
  if (!provider) {
    return undefined;
  }
  const model = activeModel?.model?.trim();
  return model ? { provider, model } : { provider };
}

async function resolveImageUnderstandingFilePath(
  ctx: BrowserScreenshotDescriptionContext,
): Promise<string> {
  const maxDimensionPx = ctx.imageSanitization?.maxDimensionPx;
  if (typeof maxDimensionPx !== "number" || !Number.isFinite(maxDimensionPx)) {
    return ctx.filePath;
  }

  const { normalizeBrowserScreenshot } = await import("./screenshot.js");
  const source = await readFile(ctx.filePath);
  const normalized = await normalizeBrowserScreenshot(source, {
    maxSide: Math.max(1, Math.floor(maxDimensionPx)),
  });
  if (normalized.buffer === source) {
    return ctx.filePath;
  }
  const { saveMediaBuffer } = await import("openclaw/plugin-sdk/media-runtime");
  const saved = await saveMediaBuffer(
    normalized.buffer,
    normalized.contentType ?? "image/jpeg",
    "browser",
  );
  return saved.path;
}

/** Produces a text description for a browser screenshot, or null when no text was produced. */
export async function describeBrowserScreenshot(
  ctx: BrowserScreenshotDescriptionContext,
): Promise<BrowserScreenshotDescriptionResult | null> {
  const filePath = await resolveImageUnderstandingFilePath(ctx);
  const agentId = ctx.agentDir
    ? undefined
    : (await import("openclaw/plugin-sdk/agent-scope-runtime")).resolveSessionAgentIdStrict({
        agentId: ctx.agentId,
        sessionKey: ctx.mediaScope?.sessionKey,
        config: ctx.cfg,
      });
  const { describeImageFile } = await import("openclaw/plugin-sdk/media-understanding-runtime");
  const described = await describeImageFile({
    filePath,
    cfg: ctx.cfg,
    prompt: DEFAULT_BROWSER_SCREENSHOT_DESCRIPTION_PROMPT,
    ...(agentId ? { agentId } : {}),
    agentDir: ctx.agentDir,
    workspaceDir: ctx.workspaceDir,
    activeModel: normalizeActiveModel(ctx.activeModel),
    scopeContext: ctx.mediaScope,
  });
  const text = described.text?.trim();
  if (!text) {
    return null;
  }
  return {
    text,
    provider: described.provider,
    model: described.model,
    decision: described.decision,
  };
}

/** Neutralizes model-generated MEDIA directives before feeding text back to tools. */
export function neutralizeMediaDirectives(text: string): string {
  if (!text || !/media:/i.test(text)) {
    return text;
  }
  // Only LF separates reply lines; multiline anchors also split CR and Unicode separators.
  return text.replace(/(^|\n)([^\S\n]*)(MEDIA:)/gi, "$1$2[neutralized] $3");
}
