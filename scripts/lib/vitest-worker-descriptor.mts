// Process-local facts shared by test runners without importing the executable bootstrap.
export type VitestWorkerPreset = "full" | "runtime";
export type VitestWorkerDescriptor = { directory: string; preset?: VitestWorkerPreset };

const descriptorKey = Symbol.for("openclaw.vitest.compiled-subprocess-descriptor");
const bootstrapProcess = process as NodeJS.Process & {
  [descriptorKey]?: VitestWorkerDescriptor;
};

export function getVitestWorkerDescriptor(): VitestWorkerDescriptor | undefined {
  return bootstrapProcess[descriptorKey];
}

export function installVitestWorkerDescriptor(descriptor: VitestWorkerDescriptor): void {
  bootstrapProcess[descriptorKey] = descriptor;
}
