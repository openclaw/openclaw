import type { ModelCatalogResult } from "../ui/src/api/types.ts";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

/** Deterministic Gateway responses for exercising the production setup UI. No provider requests. */
function installDecisionSetup(
  configInput: Record<string, unknown>,
  chatModels: unknown[],
  auth: Record<string, unknown>,
) {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Mock Gateway unavailable");
  }
  gateway.setMethodResponse("models.authStatus", {
    ...auth,
    providerCapabilities: ["anthropic", "google", "openai", "openrouter"].map((provider) => ({
      provider,
      apiKeySupported: true,
      quickApiKeySetup: true,
    })),
  });
  const scenario = new URLSearchParams(location.search).get("scenario");
  let ready = scenario === "ready";
  let rejected = scenario === "revoked";
  let revision = 0;
  const merge = (
    target: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Record<string, unknown> => {
    const next = { ...target };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete next[key];
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        next[key] = merge(
          (next[key] as Record<string, unknown>) ?? {},
          value as Record<string, unknown>,
        );
      } else {
        next[key] = value;
      }
    }
    return next;
  };
  let config = merge(configInput, {
    agents: {
      defaults: {
        decisionModel:
          scenario === "revoked"
            ? "typesafe/jev-latest"
            : scenario === "previous"
              ? "onnx/gliclass-edge-v3.0"
              : null,
      },
    },
  });
  const local = {
    kind: "local-model",
    label: "ONNX",
    help: "Prepare the model with openclaw onnx download gliclass-edge-v3.0. No API key is needed. Local files are not checked by this dialog.",
    documentationUrl: "https://docs.openclaw.ai/plugins/onnx",
  } as const;
  const decisions = (): NonNullable<ModelCatalogResult["decisionModels"]> => [
    ...["jev-latest", "jev-1.13.0"].map((id) => ({
      id,
      provider: "typesafe",
      pluginId: "typesafe",
      name: id === "jev-latest" ? "Jev" : "Jev 1.13.0",
      readiness: ready
        ? ("configured" as const)
        : rejected
          ? ("auth-rejected" as const)
          : ("setup-required" as const),
      setup: {
        kind: "api-key" as const,
        label: "TypeSafe",
        help: "Add your TypeSafe API key. This connection is shared by all agents. Saving a key does not verify it or run a paid evaluation.",
        credentialPath: ["plugins", "entries", "typesafe", "config", "apiKey"],
        documentationUrl: "https://docs.openclaw.ai/plugins/typesafe",
      },
    })),
    {
      id: "kev-latest",
      provider: "typesafe",
      pluginId: "typesafe",
      name: "Kev (local server)",
      readiness: "setup-required",
      setup: {
        kind: "local-server",
        label: "TypeSafe",
        help: "Start your System One server separately and set its loopback origin in plugin settings. No API key needed. The server chooses the checkpoint.",
        documentationUrl: "https://docs.openclaw.ai/plugins/typesafe#local-system-one-server",
      },
    },
    {
      id: "gliclass-edge-v3.0",
      provider: "onnx",
      pluginId: "onnx",
      name: "GLiClass Edge v3",
      readiness: "unknown",
      setup: local,
    },
  ];
  const publishConfig = () => {
    const hash = `decision-setup-${Date.now()}-${revision++}`;
    gateway.setMethodResponse("config.get", {
      config,
      sourceConfig: config,
      raw: JSON.stringify(config),
      hash,
      appliedConfigHash: hash,
      valid: true,
      issues: [],
    });
    return hash;
  };
  publishConfig();
  gateway.setRequestHandler("models.list", ({ respond }) =>
    respond({ models: chatModels, decisionModels: decisions() }),
  );
  gateway.setRequestHandler("config.patch", ({ params, respond }) => {
    config = merge(config, JSON.parse((params as { raw: string }).raw));
    respond({ ok: true, config, hash: publishConfig() });
  });
  gateway.setRequestHandler("plugins.credentials.set", ({ params, respond, emit }) => {
    const input = params as { value: string; pluginId: string };
    if (input.value !== "synthetic-valid") {
      respond({
        __mockError: {
          code: "INVALID_REQUEST",
          message: "The connection could not be saved. Check your input and try again.",
        },
      });
      return;
    }
    ready = true;
    rejected = false;
    config = merge(config, {
      plugins: {
        entries: {
          typesafe: {
            enabled: true,
            config: {
              apiKey: { source: "store", provider: "default", id: "SYNTHETIC_FIXTURE_REFERENCE" },
            },
          },
        },
      },
    });
    publishConfig();
    respond({ saved: true });
    emit("chat.metadata.changed", {});
  });
}
export function decisionSetupMockInitScript(
  config: Record<string, unknown>,
  models: unknown[],
  auth: Record<string, unknown>,
): string {
  return `(() => { const __name = (target) => target; (${installDecisionSetup.toString()})(${JSON.stringify(config)},${JSON.stringify(models)},${JSON.stringify(auth)}); })();`;
}
