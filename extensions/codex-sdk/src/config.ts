import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/acpx";
import {
  DEFAULT_CODEX_BACKCHANNEL_ALLOWED_METHODS,
  DEFAULT_CODEX_BACKCHANNEL_MAX_PAYLOAD_BYTES,
  DEFAULT_CODEX_BACKCHANNEL_NAME,
  DEFAULT_CODEX_BACKCHANNEL_READ_METHODS,
  DEFAULT_CODEX_BACKCHANNEL_REQUEST_TIMEOUT_MS,
  DEFAULT_CODEX_BACKCHANNEL_SAFE_WRITE_METHODS,
  DEFAULT_CODEX_ROUTES,
  DEFAULT_MAX_EVENTS_PER_SESSION,
  DEFAULT_PROPOSAL_INBOX_LIMIT,
  DEFAULT_SANDBOX_MODE,
} from "./config-defaults.js";
import {
  normalizeCodexAgentAlias,
  normalizeCodexRouteId,
  parseCodexSdkPluginConfig,
} from "./config-parse.js";
import type {
  CodexBackchannelConfig,
  CodexRouteConfig,
  ResolvedCodexBackchannelConfig,
  ResolvedCodexRouteConfig,
  ResolvedCodexSdkPluginConfig,
} from "./config-types.js";

export {
  DEFAULT_CODEX_BACKCHANNEL_ALLOWED_METHODS,
  DEFAULT_CODEX_BACKCHANNEL_MAX_PAYLOAD_BYTES,
  DEFAULT_CODEX_BACKCHANNEL_NAME,
  DEFAULT_CODEX_BACKCHANNEL_READ_METHODS,
  DEFAULT_CODEX_BACKCHANNEL_REQUEST_TIMEOUT_MS,
  DEFAULT_CODEX_BACKCHANNEL_SAFE_WRITE_METHODS,
  DEFAULT_CODEX_ROUTES,
  DEFAULT_MAX_EVENTS_PER_SESSION,
  DEFAULT_PROPOSAL_INBOX_LIMIT,
  DEFAULT_SANDBOX_MODE,
} from "./config-defaults.js";
export { normalizeCodexRouteId } from "./config-parse.js";
export * from "./config-types.js";

function resolveRoutes(
  rawRoutes: Record<string, CodexRouteConfig> | undefined,
): Record<string, ResolvedCodexRouteConfig> {
  const routes: Record<string, ResolvedCodexRouteConfig> = {};
  for (const [id, route] of Object.entries(DEFAULT_CODEX_ROUTES)) {
    routes[id] = { ...route, aliases: [...route.aliases] };
  }
  for (const [rawId, rawRoute] of Object.entries(rawRoutes ?? {})) {
    const id = normalizeCodexRouteId(rawId);
    if (!id) {
      continue;
    }
    const base = routes[id] ?? {
      id,
      label: `codex/${id}`,
      aliases: [`codex-${id}`],
    };
    const aliases = [
      ...new Set(
        [...base.aliases, ...(rawRoute.aliases ?? [])]
          .map(normalizeCodexAgentAlias)
          .filter(Boolean),
      ),
    ];
    routes[id] = {
      ...base,
      ...rawRoute,
      id,
      label: `codex/${id}`,
      aliases,
    };
  }
  return routes;
}

export function listCodexAllowedAgentsForRoutes(
  routes: Record<string, ResolvedCodexRouteConfig>,
): string[] {
  return [
    ...new Set(
      Object.values(routes)
        .flatMap((route) => route.aliases)
        .map(normalizeCodexAgentAlias)
        .filter(Boolean),
    ),
  ].toSorted();
}

export function resolveCodexRouteForAgent(
  agent: string,
  config: ResolvedCodexSdkPluginConfig,
): ResolvedCodexRouteConfig {
  const normalizedAgent = normalizeCodexAgentAlias(agent);
  const routeByAlias = new Map<string, ResolvedCodexRouteConfig>();
  for (const route of Object.values(config.routes)) {
    for (const alias of route.aliases) {
      routeByAlias.set(normalizeCodexAgentAlias(alias), route);
    }
  }
  const aliased = routeByAlias.get(normalizedAgent);
  if (aliased) {
    return aliased;
  }
  const routeId = normalizeCodexRouteId(normalizedAgent);
  return (
    config.routes[routeId] ?? config.routes[config.defaultRoute] ?? DEFAULT_CODEX_ROUTES.default
  );
}

export function isCodexAgentAllowed(agent: string, config: ResolvedCodexSdkPluginConfig): boolean {
  const normalizedAgent = normalizeCodexAgentAlias(agent);
  return config.allowedAgents.map(normalizeCodexAgentAlias).includes(normalizedAgent);
}

export function resolveCodexRouteForId(
  routeId: string | undefined,
  config: ResolvedCodexSdkPluginConfig,
): ResolvedCodexRouteConfig {
  const normalized = normalizeCodexRouteId(routeId || config.defaultRoute);
  return (
    config.routes[normalized] ?? config.routes[config.defaultRoute] ?? DEFAULT_CODEX_ROUTES.default
  );
}

function resolveBackchannelConfig(
  config: CodexBackchannelConfig | undefined,
): ResolvedCodexBackchannelConfig {
  const readMethods = config?.readMethods ?? [...DEFAULT_CODEX_BACKCHANNEL_READ_METHODS];
  const safeWriteMethods = config?.safeWriteMethods ?? [
    ...DEFAULT_CODEX_BACKCHANNEL_SAFE_WRITE_METHODS,
  ];
  return {
    ...config,
    enabled: config?.enabled ?? true,
    name: config?.name ?? DEFAULT_CODEX_BACKCHANNEL_NAME,
    readMethods,
    safeWriteMethods,
    allowedMethods: config?.allowedMethods ?? [
      ...new Set([
        ...DEFAULT_CODEX_BACKCHANNEL_ALLOWED_METHODS,
        ...readMethods,
        ...safeWriteMethods,
      ]),
    ],
    requireWriteToken: config?.requireWriteToken ?? true,
    writeTokenEnv: config?.writeTokenEnv ?? "OPENCLAW_CODEX_BACKCHANNEL_WRITE_TOKEN",
    requestTimeoutMs: config?.requestTimeoutMs ?? DEFAULT_CODEX_BACKCHANNEL_REQUEST_TIMEOUT_MS,
    maxPayloadBytes: config?.maxPayloadBytes ?? DEFAULT_CODEX_BACKCHANNEL_MAX_PAYLOAD_BYTES,
  };
}

export function resolveCodexSdkPluginConfig(params: {
  rawConfig?: unknown;
  workspaceDir?: string;
}): ResolvedCodexSdkPluginConfig {
  const parsed = parseCodexSdkPluginConfig(params.rawConfig);
  if (!parsed.ok) {
    throw new Error(`Invalid codex-sdk plugin config: ${parsed.message}`);
  }
  const config = parsed.value ?? {};
  const routes = resolveRoutes(config.routes);
  const defaultRoute = normalizeCodexRouteId(config.defaultRoute) || "default";
  if (!routes[defaultRoute]) {
    throw new Error(
      `Invalid codex-sdk plugin config: defaultRoute does not exist: ${defaultRoute}`,
    );
  }
  return {
    ...config,
    cwd: config.cwd ?? params.workspaceDir,
    inheritEnv: config.inheritEnv ?? true,
    skipGitRepoCheck: config.skipGitRepoCheck ?? false,
    sandboxMode: config.sandboxMode ?? DEFAULT_SANDBOX_MODE,
    defaultRoute,
    routes,
    allowedAgents: config.allowedAgents ?? listCodexAllowedAgentsForRoutes(routes),
    maxEventsPerSession: config.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION,
    proposalInboxLimit: config.proposalInboxLimit ?? DEFAULT_PROPOSAL_INBOX_LIMIT,
    backchannel: resolveBackchannelConfig(config.backchannel),
  };
}

export function createCodexSdkPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    validate(value: unknown) {
      const parsed = parseCodexSdkPluginConfig(value);
      if (parsed.ok) {
        return { ok: true, value: parsed.value };
      }
      return { ok: false, errors: [parsed.message] };
    },
  };
}
