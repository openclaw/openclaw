import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaGatewayChild } from "./gateway-child.js";
import type { QaProviderMode } from "./model-selection.js";
import type { QaMockProviderServer } from "./providers/shared/types.js";
import type { QaTransportActionName, QaTransportAdapter } from "./qa-transport.js";
import type { QaRuntimeSelection, RuntimeId } from "./runtime-id.js";

type QaRuntimeGatewayClient = Pick<
  QaGatewayChild,
  "baseUrl" | "tempRoot" | "workspaceDir" | "runtimeEnv" | "call"
> &
  Partial<
    Pick<
      QaGatewayChild,
      | "evidenceIdentity"
      | "getProcessCpuMs"
      | "getProcessRssBytes"
      | "logs"
      | "markLogs"
      | "readLogsSince"
      | "restart"
      | "stop"
      | "restartAfterStateMutation"
    >
  > & {
    cliCommand?: {
      executablePath: string;
      argsPrefix: readonly string[];
      cwd: string;
    };
  };

export type QaSuiteRuntimeEnv = {
  // Suite execution cells supply this identity; standalone helpers may have no cell.
  runtimeId?: RuntimeId;
  runtimeSelection?: QaRuntimeSelection;
  gateway: QaRuntimeGatewayClient;
  outputDir: string;
  transport: QaTransportAdapter;
  repoRoot: string;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  mock: Pick<QaMockProviderServer, "baseUrl" | "holdNextContinuation"> | null;
  cfg: OpenClawConfig;
};

export type QaSkillStatusEntry = {
  name?: string;
  eligible?: boolean;
  disabled?: boolean;
  blockedByAllowlist?: boolean;
};

export type QaConfigSnapshot = {
  hash?: string;
  config?: Record<string, unknown>;
};

export type QaDreamingStatus = {
  enabled?: boolean;
  shortTermCount?: number;
  promotedTotal?: number;
  phaseSignalCount?: number;
  lightPhaseHitCount?: number;
  remPhaseHitCount?: number;
  phases?: {
    deep?: {
      managedCronPresent?: boolean;
      nextRunAtMs?: number;
    };
  };
};

export type QaRuntimeActionHandlerEnv = Pick<QaSuiteRuntimeEnv, "cfg" | "transport">;
export type { QaTransportActionName };
