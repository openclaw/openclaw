import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

/**
 * before_install hook 事件类型（仅声明本模块关注的字段）
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
 * 安装扫描发现项类型
 */
type InstallFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  file: string;
  line: number;
  message: string;
};

/**
 * before_install hook 返回值类型
 */
type BeforeInstallResult = {
  findings?: InstallFinding[];
  block?: boolean;
  blockReason?: string;
};

/**
 * 注册 before_install hook，在 skill 安装前执行安全检查
 *
 * - 记录安装事件的关键信息到日志
 * - 内置安全扫描存在 critical 级别问题时阻止安装
 */
export function registerInstallGuard(api: OpenClawPluginApi): void {
  api.on(
    "before_install",
    async (event: BeforeInstallEvent): Promise<BeforeInstallResult | undefined> => {
      // 仅处理 skill 类型的安装
      if (event.targetType !== "skill") {
        return undefined;
      }

      api.logger.info(
        `[yuanbao] skill 安装检测: name=${event.targetName}, ` +
          `installId=${event.skill?.installId ?? "N/A"}, ` +
          `spec=${event.skill?.installSpec?.kind ?? "N/A"}, ` +
          `mode=${event.request.mode}, origin=${event.origin ?? "unknown"}`,
      );

      // 内置安全扫描存在 critical 级别问题时阻止安装
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
