import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export function registerCodexAccountUsage(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "codex.accountUsage",
    async (options) => {
      const { handleCodexAccountUsage } = await import("./account-usage-runtime.js");
      await handleCodexAccountUsage(options);
    },
    { scope: "operator.admin" },
  );
}
