import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  CREDENTIAL_STORE_OPTIONS,
  ShellgateCredentials,
  type ShellgateCredential,
} from "./src/credentials.js";
import { VERIFY_PATH, verifyShellgateRequest } from "./src/http.js";

export default definePluginEntry({
  id: "shellgate",
  name: "Shellgate",
  description: "Per-account Bearer authentication for trusted reverse proxies.",
  register(api) {
    api.registerCli(
      async (context) => {
        const { registerShellgateCli } = await import("./src/cli.js");
        registerShellgateCli(context);
      },
      {
        descriptors: [
          {
            name: "shellgate",
            description: "Manage proxy Bearer credentials",
            hasSubcommands: true,
            machineOutput: () => true,
          },
        ],
      },
    );
    if (api.registrationMode !== "full") {
      return;
    }
    const credentials = new ShellgateCredentials(
      api.runtime.state.openKeyedStoreV2<ShellgateCredential>(CREDENTIAL_STORE_OPTIONS),
    );
    api.registerHttpRoute({
      path: VERIFY_PATH,
      auth: "plugin",
      match: "exact",
      handler: (req, res) => verifyShellgateRequest(req, res, credentials),
    });
    for (const action of ["issue", "list", "rotate", "revoke"] as const) {
      api.registerGatewayMethod(
        `shellgate.credentials.${action}`,
        async ({ params, assertHandlerCurrent }) => {
          if (!assertHandlerCurrent) {
            throw new Error("Shellgate requires Gateway-owned request authority.");
          }
          const allowedKey = action === "issue" ? "subject" : action === "list" ? undefined : "id";
          if (Object.keys(params).some((key) => key !== allowedKey)) {
            throw new Error("Unexpected Shellgate credential parameters.");
          }
          const current = new ShellgateCredentials(
            api.runtime.state.openKeyedStoreV2<ShellgateCredential>(CREDENTIAL_STORE_OPTIONS, {
              assertCurrent: assertHandlerCurrent,
            }),
          );
          if (action === "issue") {
            return current.issue(params.subject);
          }
          if (action === "list") {
            return { credentials: await current.list() };
          }
          if (action === "rotate") {
            return current.rotate(params.id);
          }
          return current.revoke(params.id);
        },
        { scope: "operator.admin" },
      );
    }
  },
});
