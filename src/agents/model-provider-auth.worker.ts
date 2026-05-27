import { parentPort, workerData } from "node:worker_threads";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { replaceRuntimeAuthProfileStoreSnapshots, type AuthProfileStore } from "./auth-profiles.js";
import { buildCurrentProviderAuthStateSnapshot } from "./model-provider-auth.js";

type ProviderAuthWarmRuntimeAuthStore = {
  agentDir?: string;
  store: AuthProfileStore;
};

type ProviderAuthWarmWorkerInput = {
  cfg: OpenClawConfig;
  runtimeAuthStores?: ProviderAuthWarmRuntimeAuthStore[];
};

type ProviderAuthWarmWorkerResult =
  | {
      status: "ok";
      snapshot: Awaited<ReturnType<typeof buildCurrentProviderAuthStateSnapshot>>;
    }
  | {
      status: "failed";
      error: string;
    };

function isWorkerInput(value: unknown): value is ProviderAuthWarmWorkerInput {
  return (
    !!value &&
    typeof value === "object" &&
    "cfg" in value &&
    (!("runtimeAuthStores" in value) ||
      Array.isArray((value as { runtimeAuthStores?: unknown }).runtimeAuthStores))
  );
}

export async function runProviderAuthWarmWorkerInput(
  input: unknown,
): Promise<ProviderAuthWarmWorkerResult> {
  if (!isWorkerInput(input)) {
    return {
      status: "failed",
      error: "invalid provider auth warm worker input",
    };
  }
  try {
    if (input.runtimeAuthStores?.length) {
      replaceRuntimeAuthProfileStoreSnapshots(input.runtimeAuthStores);
    }
    const snapshot = await buildCurrentProviderAuthStateSnapshot(input.cfg, {
      readOnlyAuthStore: true,
    });
    return {
      status: "ok",
      snapshot,
    };
  } catch (error) {
    return {
      status: "failed",
      error: String(error),
    };
  }
}

if (parentPort) {
  const sendToParent: (message: ProviderAuthWarmWorkerResult) => void =
    parentPort.postMessage.bind(parentPort);
  sendToParent(await runProviderAuthWarmWorkerInput(workerData));
}
