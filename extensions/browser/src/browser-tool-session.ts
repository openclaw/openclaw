/** Browser-tool access and run-owner adapters. */
import type { AnyAgentTool } from "./browser-tool.runtime.js";
import {
  acquireTrackedBrowserSessionAccess,
  claimTrackedBrowserSessionOwner,
  normalizeOptionalString,
  readPositiveIntegerParam,
  readStringValue,
} from "./browser-tool.runtime.js";

export type BrowserToolSessionDeps = {
  acquireTrackedBrowserSessionAccess: typeof acquireTrackedBrowserSessionAccess;
  claimTrackedBrowserSessionOwner: typeof claimTrackedBrowserSessionOwner;
};
export type BrowserToolSessionAccess = BrowserToolSessionDeps["acquireTrackedBrowserSessionAccess"];
export type BrowserToolSessionOwnerClaim =
  BrowserToolSessionDeps["claimTrackedBrowserSessionOwner"];

const browserToolSessionDeps: BrowserToolSessionDeps = {
  acquireTrackedBrowserSessionAccess,
  claimTrackedBrowserSessionOwner,
};

export function setBrowserToolSessionDepsForTest(
  overrides: Partial<BrowserToolSessionDeps> | null,
): void {
  browserToolSessionDeps.acquireTrackedBrowserSessionAccess =
    overrides?.acquireTrackedBrowserSessionAccess ?? acquireTrackedBrowserSessionAccess;
  browserToolSessionDeps.claimTrackedBrowserSessionOwner =
    overrides?.claimTrackedBrowserSessionOwner ?? claimTrackedBrowserSessionOwner;
}

export function withBrowserSessionAccess(
  opts: { agentSessionKey?: string; sessionAccessAlreadyHeld?: boolean },
  execute: AnyAgentTool["execute"],
): AnyAgentTool["execute"] {
  if (opts.sessionAccessAlreadyHeld) {
    return execute;
  }
  return async function (this: void, ...args: Parameters<AnyAgentTool["execute"]>) {
    const releaseSessionAccess = await browserToolSessionDeps.acquireTrackedBrowserSessionAccess({
      sessionKey: opts.agentSessionKey,
    });
    try {
      args[2]?.throwIfAborted();
      return await execute(...args);
    } finally {
      releaseSessionAccess();
    }
  };
}

export function resolveBrowserSessionOwnerClaim(params: {
  sessionKey?: string;
  runId?: string;
}): number | undefined {
  if (!params.runId) {
    return undefined;
  }
  return browserToolSessionDeps.claimTrackedBrowserSessionOwner({
    sessionKey: params.sessionKey,
    ownerId: params.runId,
  });
}

export function buildBrowserSessionTabOwner(params: { runId?: string; ownerClaim?: number }): {
  ownerId?: string;
  ownerClaim?: number;
} {
  return params.runId
    ? {
        ownerId: params.runId,
        ...(params.ownerClaim !== undefined ? { ownerClaim: params.ownerClaim } : {}),
      }
    : {};
}

export function readToolTimeoutMs(params: Record<string, unknown>) {
  return readPositiveIntegerParam(params, "timeoutMs", {
    message: "timeoutMs must be a positive integer.",
  });
}

export function formatScreenshotShareHint(filePath: string): string {
  return `[Screenshot saved to ${JSON.stringify(filePath)}. Use this path with the message tool to share the screenshot explicitly.]`;
}

export function resolveConsoleTargetId(result: unknown, fallback: unknown): string | undefined {
  const resultTargetId = (result as { details?: { targetId?: unknown } }).details?.targetId;
  return readStringValue(resultTargetId) ?? normalizeOptionalString(fallback);
}
