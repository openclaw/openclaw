import type { SandboxDockerSettings } from "../../config/types.sandbox.js";

type RequiredDockerConfigKeys =
  | "image"
  | "containerPrefix"
  | "workdir"
  | "readOnlyRoot"
  | "tmpfs"
  | "network"
  | "capDrop";

/** Resolved sandbox docker config — env values are plain strings after secret resolution. */
export type SandboxDockerConfig = Omit<SandboxDockerSettings, RequiredDockerConfigKeys | "env"> &
  Required<Pick<SandboxDockerSettings, RequiredDockerConfigKeys>> & {
    env?: Record<string, string>;
  };
