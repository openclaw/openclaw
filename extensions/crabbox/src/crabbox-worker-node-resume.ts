import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { crabboxCommandError, leaseRunArgs, runCrabboxCommand } from "./crabbox-worker-command.js";
import { createCrabboxNodeResumeScript } from "./crabbox-worker-node-process.js";
import { assertCrabboxLeaseId, parseCrabboxProfile } from "./crabbox-worker-profile.js";

export function createCrabboxNodeResumer(options: {
  signal: AbortSignal;
  resolveBinary: (binary?: string, signal?: AbortSignal) => Promise<{ binary: string }>;
}): NonNullable<WorkerProvider["resumeNode"]> {
  return async (request) => {
    const signal = AbortSignal.any([request.signal, options.signal]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      request.assertCurrent();
    };
    assertCurrent();
    const profile = parseCrabboxProfile(request.profile);
    // Desktop launchers own their session environment and process receipts.
    if (request.platform !== "linux" || profile.desktop) {
      return;
    }
    assertCrabboxLeaseId(request.leaseId);
    const { binary } = await options.resolveBinary(profile.binary, signal);
    assertCurrent();
    const result = await runCrabboxCommand({
      action: "node resume",
      binary,
      args: [
        ...leaseRunArgs({ binary, provider: profile.provider, id: request.leaseId }),
        "--no-hydrate",
      ],
      input: createCrabboxNodeResumeScript(request),
      signal,
      timeoutMs: 60_000,
    });
    assertCurrent();
    if (result.termination !== "exit" || result.code !== 0) {
      throw crabboxCommandError("node resume", result);
    }
  };
}
