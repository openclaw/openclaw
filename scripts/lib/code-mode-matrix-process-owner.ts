export async function createGatewayMatrixProcessSupervisor(runtimeRoot: string) {
  const { runtimeProcessEntrypoints } =
    await import("../../src/infra/runtime-process-entrypoints.js");
  const { registerSealedRuntimeProcessEntrypoint } =
    await import("../../src/infra/runtime-process-url.js");
  const { resolveRuntimeWorkerUrl } = await import("../../src/infra/runtime-worker-url.js");
  // All cells share one prepared runtime, including staged overlays. Its native
  // owner must not load source compiler children into exclusive kernel wait ownership.
  registerSealedRuntimeProcessEntrypoint(
    "serviceChildGroupAnchor",
    resolveRuntimeWorkerUrl({
      ...runtimeProcessEntrypoints.serviceChildGroupAnchor,
      root: runtimeRoot,
    }),
  );
  const { createProcessSupervisor } = await import("../../src/process/supervisor/supervisor.js");
  return createProcessSupervisor();
}
