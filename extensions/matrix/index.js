import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/matrix";
import { matrixPlugin } from "./src/channel.js";
import { ensureMatrixCryptoRuntime } from "./src/matrix/deps.js";
import { setMatrixRuntime } from "./src/runtime.js";
const plugin = {
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setMatrixRuntime(api.runtime);
    void ensureMatrixCryptoRuntime({ log: api.logger.info }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      api.logger.warn?.(`matrix: crypto runtime bootstrap failed: ${message}`);
    });
    api.registerChannel({ plugin: matrixPlugin });
  }
};
var matrix_default = plugin;
export {
  matrix_default as default
};
