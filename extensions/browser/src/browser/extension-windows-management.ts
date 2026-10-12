import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import {
  managementRequestSchema,
  parseWindowsManagementResponse,
  WINDOWS_MANAGEMENT_LIMIT,
  type WindowsManagementRequest,
  type WindowsManagementResponse,
} from "./extension-windows-contract.js";

/** No unverified transport output is ever projected as registration state. */
export class WindowsManagementTransportError extends Error {
  readonly outcome: "unknown" | "not-started";
  constructor(started: boolean) {
    super(
      started
        ? "Windows setup outcome is unknown. Inspect the same local context before retrying; no fallback was attempted."
        : "Windows bootstrap management is unavailable. Install a compatible helper; no fallback was attempted.",
    );
    this.outcome = started ? "unknown" : "not-started";
  }
}
export async function runWindowsManagement(
  executable: string,
  request: WindowsManagementRequest,
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; run?: typeof runCommandBuffered } = {},
): Promise<WindowsManagementResponse> {
  const admitted = managementRequestSchema.parse(request);
  const input = JSON.stringify(admitted);
  if (Buffer.byteLength(input) > WINDOWS_MANAGEMENT_LIMIT) {
    throw new WindowsManagementTransportError(false);
  }
  options.signal?.throwIfAborted();
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(([key]) => !/^(NODE_|OPENCLAW_)/i.test(key)),
  );
  // Buffered process owner closes stdin after input and joins tree termination on
  // cancellation/timeout/output overflow. Chrome EOF semantics do not apply here.
  const result = await (options.run ?? runCommandBuffered)([executable, "--manage"], {
    baseEnv: env,
    input,
    timeoutMs: 60000,
    signal: options.signal,
    maxOutputBytes: { stdout: WINDOWS_MANAGEMENT_LIMIT, stderr: 1 },
    maxCombinedOutputBytes: WINDOWS_MANAGEMENT_LIMIT,
    killProcessTree: true,
    terminateOnOutputError: true,
  }).catch(() => {
    throw new WindowsManagementTransportError(true);
  });
  if (
    result.termination !== "exit" ||
    result.signal ||
    result.stderr.length ||
    options.signal?.aborted
  ) {
    throw new WindowsManagementTransportError(true);
  }
  try {
    return parseWindowsManagementResponse(result.stdout, result.code, admitted);
  } catch {
    throw new WindowsManagementTransportError(true);
  }
}
