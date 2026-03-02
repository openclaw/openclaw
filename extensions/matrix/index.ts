import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { matrixPlugin } from "./src/channel.js";
import { registerMatrixCli } from "./src/cli.js";
import {
  getMatrixRecoveryKeyHandler,
  getMatrixVerificationStore,
} from "./src/matrix/recovery-key/index.js";
import { setMatrixRuntime } from "./src/runtime.js";

const plugin = {
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMatrixRuntime(api.runtime);
    api.registerChannel({ plugin: matrixPlugin });

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    // Gateway RPC: verify device with recovery key
    api.registerGatewayMethod(
      "matrix.verify.recoveryKey",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const key = typeof params?.key === "string" ? params.key.trim() : "";
          if (!key) {
            respond(false, { error: "key required" });
            return;
          }
          const accountId =
            typeof params?.accountId === "string" ? params.accountId.trim() : undefined;
          const handler = getMatrixRecoveryKeyHandler(accountId);
          if (!handler) {
            respond(false, {
              error: accountId
                ? `No recovery key handler for account "${accountId}" — is Matrix E2EE running?`
                : "No recovery key handler — is Matrix E2EE running?",
            });
            return;
          }
          const result = await handler.verifyWithRecoveryKey(key);
          if (!result.success) {
            respond(false, result);
            return;
          }
          respond(true, result);
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // Gateway RPC: check verification status
    api.registerGatewayMethod(
      "matrix.verify.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const accountId =
            typeof params?.accountId === "string" ? params.accountId.trim() : undefined;
          const store = getMatrixVerificationStore(accountId);
          if (!store) {
            respond(false, {
              error: accountId
                ? `No verification store for account "${accountId}" — is Matrix E2EE running?`
                : "No verification store — is Matrix E2EE running?",
            });
            return;
          }
          respond(true, store.getState());
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // CLI: openclaw matrix verify ...
    api.registerCli(
      ({ program, config, logger }) => registerMatrixCli({ program, config, logger }),
      { commands: ["matrix"] },
    );
  },
};

export default plugin;
