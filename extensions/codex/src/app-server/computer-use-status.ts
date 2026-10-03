import {
  skippedLiveTestStatus,
  type CodexComputerUseLiveTestStatus,
  type CodexComputerUseRepairStatus,
} from "./computer-use-readiness.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";

export type CodexComputerUseStatusReason =
  | "disabled"
  | "marketplace_missing"
  | "plugin_not_installed"
  | "plugin_disabled"
  | "mcp_missing"
  | "live_test_failed"
  | "ready"
  | "check_failed"
  | "auto_install_blocked";

type CodexComputerUseInstallationStatus =
  | "disabled"
  | "marketplace_missing"
  | "not_installed"
  | "unchecked"
  | "installed_disabled"
  | "installed";

type CodexComputerUseExposureStatus = "skipped" | "missing" | "available";

type CodexComputerUseStatusSection = {
  status: string;
  ok: boolean;
  message: string;
};

export type CodexComputerUseStatus = {
  enabled: boolean;
  ready: boolean;
  reason: CodexComputerUseStatusReason;
  installed: boolean | null;
  pluginEnabled: boolean;
  mcpServerAvailable: boolean;
  pluginName: string;
  mcpServerName: string;
  marketplaceName?: string;
  marketplacePath?: string;
  tools: string[];
  installation: CodexComputerUseStatusSection & {
    status: CodexComputerUseInstallationStatus;
  };
  exposure: CodexComputerUseStatusSection & {
    status: CodexComputerUseExposureStatus;
  };
  liveTest: CodexComputerUseLiveTestStatus;
  repair?: CodexComputerUseRepairStatus;
  warnings: string[];
  message: string;
};

export function unavailableStatus(
  config: ResolvedCodexComputerUseConfig,
  reason: CodexComputerUseStatus["reason"],
  message: string,
): CodexComputerUseStatus {
  const disabled = reason === "disabled";
  return {
    enabled: !disabled,
    ready: false,
    reason,
    installed: reason === "plugin_disabled" ? null : false,
    pluginEnabled: false,
    mcpServerAvailable: false,
    pluginName: config.pluginName,
    mcpServerName: config.mcpServerName,
    ...(!disabled && config.marketplaceName ? { marketplaceName: config.marketplaceName } : {}),
    ...(!disabled && config.marketplacePath ? { marketplacePath: config.marketplacePath } : {}),
    tools: [],
    installation: {
      status: disabled
        ? "disabled"
        : reason === "plugin_disabled"
          ? "unchecked"
          : reason === "marketplace_missing"
            ? "marketplace_missing"
            : "not_installed",
      ok: false,
      message,
    },
    exposure: {
      status: "skipped",
      ok: false,
      message: disabled
        ? "MCP exposure was not checked because Computer Use is disabled."
        : "MCP exposure was not checked because Computer Use installation is not ready.",
    },
    liveTest: skippedLiveTestStatus(
      config,
      disabled
        ? "Computer Use live test was not run because Computer Use is disabled."
        : "Computer Use live test was not run because installation is not ready.",
    ),
    warnings: [],
    message,
  };
}
