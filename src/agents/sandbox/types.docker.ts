/**
 * Normalized Docker sandbox config type.
 *
 * Defaults fill required runtime fields from user-facing Docker sandbox settings.
 */
import type { SandboxDockerSettings } from "../../config/types.sandbox.js";

type RequiredDockerConfigKeys =
  | "image"
  | "containerPrefix"
  | "workdir"
  | "readOnlyRoot"
  | "tmpfs"
  | "network"
  | "capDrop";

type SandboxDockerRuntimeSettings = Omit<SandboxDockerSettings, "env"> & {
  env?: Record<string, string>;
};

export type SandboxDockerConfig = Omit<SandboxDockerRuntimeSettings, RequiredDockerConfigKeys> &
  Required<Pick<SandboxDockerRuntimeSettings, RequiredDockerConfigKeys>>;
