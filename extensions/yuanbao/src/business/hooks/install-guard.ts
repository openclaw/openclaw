import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

/**
 * before_install hook event type (only fields relevant to this module).
 */
type BeforeInstallEvent = {
  targetType: "skill" | "plugin";
  targetName: string;
  origin?: string;
  request: {
    mode: "install" | "update";
    kind: string;
  };
  builtinScan: {
    status: "ok" | "error";
    critical: number;
    warn: number;
    info: number;
    findings: unknown[];
  };
  skill?: {
    installId: string;
    installSpec?: {
      kind: string;
    };
  };
};

/**
 * Install scan finding type.
 */
type InstallFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  file: string;
  line: number;
  message: string;
};

/**
 * before_install hook return type.
 */
type BeforeInstallResult = {
  findings?: InstallFinding[];
  block?: boolean;
  blockReason?: string;
};

/**
 * Register before_install hook to perform security checks before skill installation.
 * Blocks installation when builtin scan has critical-level findings.
 */
export function registerInstallGuard(api: OpenClawPluginApi): void {
  api.on(
    "before_install",
    async (event: BeforeInstallEvent): Promise<BeforeInstallResult | undefined> => {
      // Only handle skill-type installations
      if (event.targetType !== "skill") {
        return undefined;
      }

      api.logger.info(
        `[yuanbao] skill 安装检测: name=${event.targetName}, ` +
          `installId=${event.skill?.installId ?? "N/A"}, ` +
          `spec=${event.skill?.installSpec?.kind ?? "N/A"}, ` +
          `mode=${event.request.mode}, origin=${event.origin ?? "unknown"}`,
      );

      // Block installation when builtin scan has critical-level findings
      if (event.builtinScan.critical > 0) {
        api.logger.warn(
          `[yuanbao] skill "${event.targetName}" 存在 ${event.builtinScan.critical} 个 critical 级别安全问题，已阻止安装`,
        );
        return {
          block: true,
          blockReason: `yuanbao: skill "${event.targetName}" 存在 ${event.builtinScan.critical} 个 critical 级别安全问题`,
        };
      }

      return undefined;
    },
  );
}
