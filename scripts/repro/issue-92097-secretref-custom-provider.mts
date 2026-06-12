import { NON_ENV_SECRETREF_MARKER } from "../../src/agents/model-auth-markers.js";
import {
  hasRuntimeAvailableProviderAuth,
  resolveApiKeyForProvider,
} from "../../src/agents/model-auth.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../../src/config/config.js";

const sourceConfig = {
  models: {
    providers: {
      cliproxyapi: {
        api: "openai-responses",
        apiKey: NON_ENV_SECRETREF_MARKER,
      },
    },
  },
};

const runtimeConfig = {
  models: {
    providers: {
      cliproxyapi: {
        api: "openai-responses",
        apiKey: "resolved-secretref-key",
      },
    },
  },
};

async function main() {
  console.log("=== Reproduction for issue #92097 ===");
  console.log("Source config apiKey:", sourceConfig.models.providers.cliproxyapi.apiKey);
  console.log("Runtime config apiKey:", runtimeConfig.models.providers.cliproxyapi.apiKey);
  console.log();

  setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

  try {
    const available = hasRuntimeAvailableProviderAuth({
      provider: "cliproxyapi",
      cfg: sourceConfig,
    });
    console.log("Runtime available auth:", available);

    const resolved = await resolveApiKeyForProvider({
      provider: "cliproxyapi",
      cfg: sourceConfig,
      store: { version: 1, profiles: {} },
    });

    console.log("Resolved auth:", resolved);

    if (available && resolved?.apiKey === "resolved-secretref-key") {
      console.log(
        "\nPASS: Custom provider secretref-managed apiKey is available and correctly resolved from runtime snapshot.",
      );
    } else {
      console.error(
        "\nFAIL: Expected available=true and apiKey 'resolved-secretref-key', got available=",
        available,
        "apiKey=",
        resolved?.apiKey,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("\nFAIL: Threw error:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    clearRuntimeConfigSnapshot();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
