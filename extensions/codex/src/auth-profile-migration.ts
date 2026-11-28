import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";

/** Explicit operator repair; normal execution must never infer an identity change. */
export function registerCodexAuthProfileMigration(
  api: Pick<OpenClawPluginApi, "registerGatewayMethod">,
  bindingStore: Pick<CodexAppServerBindingStore, "mutate" | "withLease">,
): void {
  api.registerGatewayMethod(
    "codex.migrateAuthProfile",
    async (options) => {
      const { handleCodexAuthProfileMigration } =
        await import("./auth-profile-migration-runtime.js");
      await handleCodexAuthProfileMigration(options, bindingStore);
    },
    { scope: "operator.admin" },
  );
}
