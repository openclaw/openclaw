import path from "node:path";
import { writeSealedRuntimeProcessFixture } from "../../src/test-utils/sealed-runtime-process-fixture.js";

export async function prepareGatewayMatrixProcessOwner(runtimeRoot: string, fixtureRoot: string) {
  const { runtimeProcessEntrypoints } =
    await import("../../src/infra/runtime-process-entrypoints.js");
  const { resolveRuntimeWorkerUrl } = await import("../../src/infra/runtime-worker-url.js");
  // All cells share one prepared runtime, including staged overlays. Its native
  // owner must not load source compiler children into exclusive kernel wait ownership.
  return await writeSealedRuntimeProcessFixture(
    path.join(fixtureRoot, "process-owner"),
    "serviceChildRelay",
    {
      serviceChildGroupAnchor: resolveRuntimeWorkerUrl({
        ...runtimeProcessEntrypoints.serviceChildGroupAnchor,
        root: runtimeRoot,
      }),
    },
  );
}

export async function createGatewayMatrixProcessSupervisor(bootstrap: string) {
  const { registerSealedRuntimeProcessEntrypoints } =
    await import("../../src/infra/runtime-process-url.js");
  registerSealedRuntimeProcessEntrypoints("serviceChildRelay", bootstrap);
  const { createProcessSupervisor } = await import("../../src/process/supervisor/supervisor.js");
  return createProcessSupervisor();
}
