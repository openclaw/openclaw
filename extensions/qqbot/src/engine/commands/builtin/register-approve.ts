import type { ApproveRuntimeGetter } from "../../adapter/commands.port.js";
import type { SlashCommandRegistry } from "../slash-commands.js";
import { getApproveRuntimeGetter } from "./state.js";

export function registerApproveCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: "bot-approve",
    description: "管理命令执行审批配置",
    requireAuth: true,
    c2cOnly: true,
    usage: [
      `/bot-approve            查看操作指引`,
      `/bot-approve on         开启审批（白名单模式，推荐）`,
      `/bot-approve off        关闭审批，命令直接执行`,
      `/bot-approve always     始终审批，每次执行都需审批`,
      `/bot-approve reset      恢复框架默认值`,
      `/bot-approve status     查看当前审批配置`,
    ].join("\n"),
    handler: async (ctx) => {
      const arg = ctx.args.trim().toLowerCase();

      let runtime: ReturnType<NonNullable<ApproveRuntimeGetter>>;
      try {
        const getter = getApproveRuntimeGetter();
        if (!getter) {
          throw new Error("runtime not available");
        }
        runtime = getter();
      } catch {
        return [
          `🔐 命令执行审批配置`,
          ``,
          `❌ 当前环境不支持在线配置修改，请通过 CLI 手动配置：`,
          ``,
          `\`\`\`shell`,
          `# 开启审批（白名单模式）`,
          `openclaw config set tools.exec.mode ask`,
          ``,
          `# 关闭审批`,
          `openclaw config set tools.exec.mode full`,
          `\`\`\``,
        ].join("\n");
      }

      const configApi = runtime.config;

      const loadExecConfig = () => {
        const cfg = configApi.current();
        const tools = ((cfg as Record<string, unknown>).tools ?? {}) as Record<string, unknown>;
        const exec = (tools.exec ?? {}) as Record<string, unknown>;
        const mode = typeof exec.mode === "string" ? exec.mode : "ask";
        return { mode };
      };

      const writeExecConfig = async (mode: string) => {
        const cfg = structuredClone(configApi.current() as Record<string, unknown>);
        const tools = (cfg.tools ?? {}) as Record<string, unknown>;
        const exec = (tools.exec ?? {}) as Record<string, unknown>;
        exec.mode = mode;
        delete exec.security;
        delete exec.ask;
        tools.exec = exec;
        cfg.tools = tools;
        await configApi.replaceConfigFile({ nextConfig: cfg, afterWrite: { mode: "auto" } });
      };

      const formatStatus = (mode: string) => {
        const modeIcon = mode === "full" ? "🟢" : mode === "deny" ? "🔴" : "🟡";
        return [
          `🔐 当前审批配置`,
          ``,
          `${modeIcon} 执行模式 (mode): **${mode}**`,
          ``,
          mode === "deny"
            ? `⚠️ 当前为 deny 模式，所有命令执行被拒绝`
            : mode === "full"
              ? `✅ 所有命令无需审批直接执行`
              : mode === "always"
                ? `🛡️ 严格审批模式，每次命令执行都需审批`
                : mode === "ask" || mode === "auto"
                  ? `🛡️ 白名单命令直接执行，其余需审批`
                  : `ℹ️ mode=${mode}`,
        ].join("\n");
      };

      if (!arg) {
        return [
          `🔐 命令执行审批配置`,
          ``,
          `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（白名单模式）`,
          `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
          `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
          `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
          `<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置`,
        ].join("\n");
      }

      if (arg === "status") {
        const { mode } = loadExecConfig();
        return [
          formatStatus(mode),
          ``,
          `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批`,
          `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
          `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
          `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
        ].join("\n");
      }

      if (arg === "on") {
        try {
          await writeExecConfig("ask");
          return [
            `✅ 审批已开启`,
            ``,
            `• mode = ask（未命中白名单时需审批）`,
            ``,
            `已批准的命令自动加入白名单，下次直接执行。`,
          ].join("\n");
        } catch (err: unknown) {
          return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (arg === "off") {
        try {
          await writeExecConfig("full");
          return [
            `✅ 审批已关闭`,
            ``,
            `• mode = full（允许所有命令，不需要审批）`,
            ``,
            `⚠️ 所有命令将直接执行，不会弹出审批确认。`,
          ].join("\n");
        } catch (err: unknown) {
          return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (arg === "always" || arg === "strict") {
        try {
          await writeExecConfig("always");
          return [`✅ 已切换为严格审批模式`, ``, `• mode = always（每次命令执行都需审批）`].join(
            "\n",
          );
        } catch (err: unknown) {
          return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (arg === "reset") {
        try {
          const cfg = structuredClone(configApi.current() as Record<string, unknown>);
          const tools = (cfg.tools ?? {}) as Record<string, unknown>;
          const exec = (tools.exec ?? {}) as Record<string, unknown>;
          delete exec.mode;
          delete exec.security;
          delete exec.ask;
          if (Object.keys(exec).length === 0) {
            delete tools.exec;
          } else {
            tools.exec = exec;
          }
          if (Object.keys(tools).length === 0) {
            delete cfg.tools;
          } else {
            cfg.tools = tools;
          }
          await configApi.replaceConfigFile({ nextConfig: cfg, afterWrite: { mode: "auto" } });
          return [
            `✅ 审批配置已重置`,
            ``,
            `已移除 tools.exec.mode`,
            `框架将使用默认值`,
            ``,
            `如需开启命令执行，请使用 /bot-approve on`,
          ].join("\n");
        } catch (err: unknown) {
          return `❌ 配置更新失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return [
        `❌ 未知参数: ${arg}`,
        ``,
        `可用选项: on | off | always | reset | status`,
        `输入 /bot-approve ? 查看详细用法`,
      ].join("\n");
    },
  });
}
