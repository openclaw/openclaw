import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  CodexAppServerBindingStore,
  CodexBindingStateStore,
} from "./app-server/session-binding.js";

export function registerOwnerDmRecovery(
  api: OpenClawPluginApi,
  bindings: Pick<CodexBindingStateStore, "lookup" | "entries">,
  store: CodexAppServerBindingStore,
): void {
  for (const action of ["inspect", "reset"] as const) {
    api.registerGatewayMethod(
      `codex.ownerDmRecovery.${action}`,
      async (options) => {
        const { handleOwnerDmRecovery } = await import("./owner-dm-recovery-runtime.js");
        await handleOwnerDmRecovery(action, options, bindings, store);
      },
      { scope: "operator.admin" },
    );
  }
}
