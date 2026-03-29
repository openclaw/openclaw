import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { matrixPlugin } from "./src/channel.js";
import { setMatrixRuntime } from "./src/runtime.js";

export { matrixPlugin } from "./src/channel.js";
export { setMatrixRuntime } from "./src/runtime.js";

const matrixEntry = defineChannelPluginEntry({
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  plugin: matrixPlugin,
  setRuntime: setMatrixRuntime,
});

export default {
  ...matrixEntry,
  register(api: OpenClawPluginApi) {
    matrixEntry.register(api);
    // Expose Matrix CLI metadata during descriptor capture without crossing
    // into the full runtime bootstrap path.
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
    if (api.registrationMode !== "full") {
      return;
    }

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
};
