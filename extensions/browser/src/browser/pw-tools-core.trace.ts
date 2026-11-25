import { holdBrowserConnection } from "./browser-connection-holds.js";
import { writeExternalFileWithinOutputRoot } from "./output-files.js";
import { DEFAULT_TRACE_DIR } from "./paths.js";
import { ensureContextState, getPageForTargetId } from "./pw-session.js";

export async function traceStartViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  screenshots?: boolean;
  snapshots?: boolean;
  sources?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
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
  // Recording spans requests; an idle release would close the context and lose the trace.
  const release = holdBrowserConnection(opts.cdpUrl);
  ctxState.releaseTraceConnection = release;
  context.once("close", release);
}

export async function traceStopViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  path: string;
}): Promise<string> {
  const page = await getPageForTargetId(opts);
  const context = page.context();
  const ctxState = ensureContextState(context);
  if (!ctxState.traceActive) {
    throw new Error("No active trace. Start a trace before stopping it.");
  }
  return await writeExternalFileWithinOutputRoot({
    rootDir: DEFAULT_TRACE_DIR,
    path: opts.path,
    write: async (tempPath) => {
      await context.tracing.stop({ path: tempPath });
      // Playwright owns the recording lifecycle. Once stop succeeds, a later
      // fs-safe publication failure must not leave this context marked active.
      ctxState.traceActive = false;
      const releaseConnection = ctxState.releaseTraceConnection;
      ctxState.releaseTraceConnection = undefined;
      if (releaseConnection) {
        context.off("close", releaseConnection);
        releaseConnection();
      }
    },
  });
}
