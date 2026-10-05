import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import type { CrabboxProvisionStageEvent } from "./crabbox-worker-provision-telemetry.js";
import type { CrabboxWarmImagePolicy } from "./crabbox-worker-warm-image-policy.js";
import type { CrabboxState } from "./crabbox-worker-warm-image-store.js";

export type CrabboxWorkerProviderDependencies = {
  isExecutable?: (candidate: string) => boolean;
  openclawRoot?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  runCommand?: CrabboxCommandRunner;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  wallpaperPath: string;
  state: CrabboxState;
  warn?: (message: string) => void;
  onProvisionStage?: (event: CrabboxProvisionStageEvent) => void;
  warmImagePolicy?: CrabboxWarmImagePolicy;
};
