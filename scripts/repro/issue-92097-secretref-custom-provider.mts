import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NON_ENV_SECRETREF_MARKER } from "../../src/agents/model-auth-markers.js";
import {
  hasRuntimeAvailableProviderAuth,
  resolveApiKeyForProvider,
} from "../../src/agents/model-auth.js";
import { clearRuntimeConfigSnapshot } from "../../src/config/config.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../../src/secrets/runtime.js";

const providerId = "cliproxyapi";

function createBaseProviderConfig() {
  return {
    api: "openai-responses",
    baseUrl: "http://localhost:8080/v1",
    models: [
      {
        id: "test-model",
        name: "Test Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ],
  };
}

async function main() {
  console.log("=== Reproduction for issue #92097 ===");
  console.log(
    "Proving managed SecretRef custom-provider auth through actual file-based SecretRef preparation.",
  );
  console.log();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-92097-"));
  const secretsFile = path.join(tmpDir, "secrets.json");

  try {
    await fs.writeFile(
      secretsFile,
      JSON.stringify({
        providers: {
          [providerId]: {
            apiKey: "resolved-from-file-secret", // pragma: allowlist secret
          },
        },
      }),
    );

    // Source config as it would appear on disk after a previous session: the
    // non-env SecretRef has been normalized to the managed marker, while the
    // actual value lives in the secrets file and is prepared into the runtime
    // snapshot below.
    const markerSourceConfig = {
      models: {
        providers: {
          [providerId]: {
            ...createBaseProviderConfig(),
            apiKey: NON_ENV_SECRETREF_MARKER,
          },
        },
      },
    } as const;

    // Independent source config used to prepare the runtime snapshot. It keeps
    // the structured file SecretRef so prepareSecretsRuntimeSnapshot resolves it
    // from the real secrets file instead of being injected manually.
    const resolvedSourceConfig = {
      models: {
        providers: {
          [providerId]: {
            ...createBaseProviderConfig(),
            apiKey: {
              source: "file",
              provider: "local-file",
              id: `/providers/${providerId}/apiKey`,
            },
          },
        },
      },
      secrets: {
        providers: {
          "local-file": {
            source: "file",
            path: secretsFile,
            mode: "json",
            allowInsecurePath: true,
          },
        },
      },
    } as const;

    const prepared = await prepareSecretsRuntimeSnapshot({
      config:
        resolvedSourceConfig as unknown as import("../../src/config/types.openclaw.js").OpenClawConfig,
      includeAuthStoreRefs: false,
    });
    activateSecretsRuntimeSnapshot(prepared);

    const available = hasRuntimeAvailableProviderAuth({
      provider: providerId,
      cfg: markerSourceConfig as unknown as import("../../src/config/types.openclaw.js").OpenClawConfig,
    });
    console.log("Runtime available auth:", available);

    const resolved = await resolveApiKeyForProvider({
      provider: providerId,
      cfg: markerSourceConfig as unknown as import("../../src/config/types.openclaw.js").OpenClawConfig,
      store: { version: 1, profiles: {} },
    });

    console.log("Resolved auth:", {
      apiKey: resolved.apiKey,
      source: resolved.source,
      mode: resolved.mode,
    });

    if (available && resolved?.apiKey === "resolved-from-file-secret") {
      console.log(
        "\nPASS: Custom provider secretref-managed apiKey is available and correctly resolved from file-backed SecretRef runtime snapshot.",
      );
    } else {
      console.error(
        "\nFAIL: Expected available=true and apiKey 'resolved-from-file-secret', got available=",
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
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
