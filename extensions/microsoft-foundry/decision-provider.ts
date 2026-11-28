import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER = "microsoft-foundry-systemone";
const catalog = manifest.modelCatalog.providers[PROVIDER];
const model = expectDefined(catalog.models[0], "Microsoft Foundry Decision model");
const routeSchema = manifest.configSchema.properties.decision.properties;
const hostPattern = new RegExp(routeSchema.resourceHost.pattern, "u");
const deploymentPattern = new RegExp(routeSchema.deployment.pattern, "u");
const loadRuntime = createLazyRuntimeModule(() => import("./decision-provider.runtime.js"));

export type FoundryDecisionRoute = { host: string; deployment: string };
type RuntimeConfig = ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>;

function readRoute(config: RuntimeConfig | undefined): FoundryDecisionRoute | undefined {
  const decision = config?.plugins?.entries?.[manifest.id]?.config?.decision;
  if (!decision || typeof decision !== "object") {
    return undefined;
  }
  const { resourceHost: host, deployment } = decision as Readonly<Record<string, unknown>>;
  return typeof host === "string" &&
    host === host.trim() &&
    hostPattern.test(host) &&
    typeof deployment === "string" &&
    deployment === deployment.trim() &&
    deploymentPattern.test(deployment)
    ? { host, deployment }
    : undefined;
}

export function buildFoundryDecisionProvider(getConfig: () => RuntimeConfig): DecisionProviderV2 {
  const matchesLiveRoute = (route: FoundryDecisionRoute): boolean => {
    const live = readRoute(getConfig());
    return live?.host === route.host && live.deployment === route.deployment;
  };
  return {
    id: PROVIDER,
    contractVersion: 2,
    provider: {
      label: model.name,
      auth: [],
      authScope: "plugin",
      normalizeTransport: ({ config }) => {
        const route = readRoute(config);
        return route ? { baseUrl: `https://${route.host}/providers/microsoft/v1` } : undefined;
      },
      resolveSyntheticAuth: ({ config }) => {
        const route = readRoute(config);
        if (!route || !matchesLiveRoute(route)) {
          return undefined;
        }
        const key = getPreparedPluginSecretInput(manifest.id, "decision.apiKey").value?.trim();
        return key && !/\s/u.test(key)
          ? { apiKey: key, source: "Foundry Decision plugin", mode: "api-key" }
          : undefined;
      },
    },
    async evaluate(batch, context) {
      if (context.model.provider !== PROVIDER || context.model.id !== model.id) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      context.signal.throwIfAborted();
      const route = readRoute(context.config);
      if (!route) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const { evaluateFoundryDecision } = await loadRuntime();
      context.signal.throwIfAborted();
      return evaluateFoundryDecision(
        batch,
        context,
        route,
        () => matchesLiveRoute(route),
        model.id,
      );
    },
  };
}
