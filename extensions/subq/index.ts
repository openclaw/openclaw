import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const loadRuntime = createLazyRuntimeModule(() => import("./src/runtime.js"));
const credential = () => getPreparedPluginSecretInput("subq", "apiKey").value;

export default definePluginEntry({
  id: "subq",
  name: "SubQ",
  description: manifest.description,
  configSchema: { jsonSchema: manifest.configSchema },
  register(api) {
    api.registerDecisionProvider({
      id: "subq",
      contractVersion: 1,
      isReady: () => Boolean(credential()),
      async evaluate(batch, context) {
        context.signal.throwIfAborted();
        const { evaluate } = await loadRuntime();
        context.signal.throwIfAborted();
        // Read the host-prepared credential after loading; never cache or resolve SecretRefs here.
        const apiKey = credential();
        if (!apiKey) {
          return { status: "unavailable", reason: "credentials-unavailable" };
        }
        return evaluate(batch, context, apiKey);
      },
    });
  },
});
