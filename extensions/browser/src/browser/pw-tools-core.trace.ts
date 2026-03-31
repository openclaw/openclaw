import type { Page } from "playwright-core";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { writeViaSiblingTempPath } from "./output-atomic.js";
import { DEFAULT_TRACE_DIR } from "./paths.js";
import { ensureContextState } from "./pw-session.js";
import { getAllowedPageForTarget } from "./pw-tools-core.followup-guard.js";

export async function traceStartViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  screenshots?: boolean;
  snapshots?: boolean;
  sources?: boolean;
  page?: Page;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  const page = await getAllowedPageForTarget(opts);
  const context = page.context();
  const ctxState = ensureContextState(context);
  if (ctxState.traceActive) {
    throw new Error("Trace already running. Stop the current trace before starting a new one.");
  }
  await context.tracing.start({
    screenshots: opts.screenshots ?? true,
    snapshots: opts.snapshots ?? true,
    sources: opts.sources ?? false,
  });
  ctxState.traceActive = true;
}

export async function traceStopViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  path: string;
  page?: Page;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  const page = await getAllowedPageForTarget(opts);
  const context = page.context();
  const ctxState = ensureContextState(context);
  if (!ctxState.traceActive) {
    throw new Error("No active trace. Start a trace before stopping it.");
  }
  await writeViaSiblingTempPath({
    rootDir: DEFAULT_TRACE_DIR,
    targetPath: opts.path,
    writeTemp: async (tempPath) => {
      await context.tracing.stop({ path: tempPath });
    },
  });
  ctxState.traceActive = false;
}
