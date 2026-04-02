import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { matrixPlugin } from "./src/channel.js";
import { setMatrixRuntime } from "./src/runtime.js";

export { matrixPlugin } from "./src/channel.js";
export { setMatrixRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  plugin: matrixPlugin,
  setRuntime: setMatrixRuntime,
  registerCliMetadata(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerMatrixCli } = await import("./src/cli.js");
        registerMatrixCli({ program });
      },
      {
        descriptors: [
          {
            name: "matrix",
            description: "Manage Matrix accounts, verification, devices, and profile state",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
  registerFull(api) {
    void import("./src/plugin-entry.runtime.js")
      .then(({ ensureMatrixCryptoRuntime }) =>
        ensureMatrixCryptoRuntime({ log: api.logger.info }).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          api.logger.warn?.(`matrix: crypto runtime bootstrap failed: ${message}`);
        }),
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.warn?.(`matrix: failed loading crypto bootstrap runtime: ${message}`);
      });

    api.registerGatewayMethod("matrix.verify.recoveryKey", async (ctx) => {
      const { handleVerifyRecoveryKey } = await import("./src/plugin-entry.runtime.js");
      await handleVerifyRecoveryKey(ctx);
    });

    api.registerGatewayMethod("matrix.verify.bootstrap", async (ctx) => {
      const { handleVerificationBootstrap } = await import("./src/plugin-entry.runtime.js");
      await handleVerificationBootstrap(ctx);
    });

    api.registerGatewayMethod("matrix.verify.status", async (ctx) => {
      const { handleVerificationStatus } = await import("./src/plugin-entry.runtime.js");
      await handleVerificationStatus(ctx);
    });
  },
});
