import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";

export type CrabboxWorkerNodeRuntimePreparation = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["prepareNodeRuntime"]>
  >
>;
