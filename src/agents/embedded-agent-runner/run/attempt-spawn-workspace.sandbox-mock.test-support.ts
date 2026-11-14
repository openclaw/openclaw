import { vi } from "vitest";

type SandboxRuntime = typeof import("../../sandbox/runtime-status.js");
const { resolvePreparedSandboxRuntimeStatus } = await vi.importActual<SandboxRuntime>(
  "../../sandbox/runtime-status.js",
);

export const resolveSandboxRuntimeStatus: SandboxRuntime["resolveSandboxRuntimeStatus"] = (
  params,
) => resolvePreparedSandboxRuntimeStatus({ ...params, preparedSessionEntry: null });

export const withSandboxRuntimeStatusInWorker: SandboxRuntime["withSandboxRuntimeStatusInWorker"] =
  async (params, _source, consume) => await consume(resolveSandboxRuntimeStatus(params));
