import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type AutoAgentConfig = {
  enabled?: boolean;
  checkIntervalMs?: number;
  maxChangesPerCommit?: number;
  selfHealing?: boolean;
  autoRollback?: boolean;
  gitAutoCommit?: boolean;
  webSearch?: {
    enabled?: boolean;
    provider?: "brave" | "perplexity" | "grok";
  };
};

export default function register(api: OpenClawPluginApi) {
  // Expose auto-agent status command
  api.registerCommand({
    name: "auto-agent",
    description: "Show auto-agent status and configuration.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const cfg = api.runtime.config.loadConfig();
      const pluginCfg = (cfg.plugins?.entries?.["auto-agent"]?.config ?? {}) as AutoAgentConfig;

      const args = ctx.args?.trim() ?? "";
      const action = args.split(/\s+/)[0]?.toLowerCase() ?? "status";

      if (action === "status" || !action) {
        const lines = [
          "🤖 Auto-Agent Status",
          "",
          `enabled:          ${pluginCfg.enabled ?? false}`,
          `checkIntervalMs:  ${pluginCfg.checkIntervalMs ?? 60000}ms`,
          `selfHealing:      ${pluginCfg.selfHealing ?? true}`,
          `autoRollback:     ${pluginCfg.autoRollback ?? true}`,
          `gitAutoCommit:    ${pluginCfg.gitAutoCommit ?? false}`,
          "",
          "Web Search:",
          `  enabled:  ${pluginCfg.webSearch?.enabled ?? true}`,
          `  provider: ${pluginCfg.webSearch?.provider ?? "brave"}`,
        ];

        const braveKey = process.env["BRAVE_API_KEY"] ?? "";
        const hasKey = braveKey && !braveKey.includes("your_") && braveKey.length > 10;
        lines.push(
          `  api-key:  ${hasKey ? "✅ set" : "❌ not set – BRAVE_API_KEY missing in .env"}`,
        );

        return { text: lines.join("\n") };
      }

      if (action === "enable") {
        const nextCfg = {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: {
              ...(cfg.plugins?.entries ?? {}),
              "auto-agent": {
                ...(cfg.plugins?.entries?.["auto-agent"] ?? {}),
                enabled: true,
                config: { ...pluginCfg, enabled: true },
              },
            },
          },
        };
        await api.runtime.config.writeConfigFile(nextCfg);
        return { text: "✅ auto-agent enabled" };
      }

      if (action === "disable") {
        const nextCfg = {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: {
              ...(cfg.plugins?.entries ?? {}),
              "auto-agent": {
                ...(cfg.plugins?.entries?.["auto-agent"] ?? {}),
                enabled: false,
                config: { ...pluginCfg, enabled: false },
              },
            },
          },
        };
        await api.runtime.config.writeConfigFile(nextCfg);
        return { text: "⏹️ auto-agent disabled" };
      }

      return {
        text: [
          "Auto-agent commands:",
          "",
          "/auto-agent status   – show configuration",
          "/auto-agent enable   – enable autonomous mode",
          "/auto-agent disable  – disable autonomous mode",
        ].join("\n"),
      };
    },
  });
}
