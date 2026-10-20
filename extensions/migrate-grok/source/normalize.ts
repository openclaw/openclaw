import { createHash } from "node:crypto";
import { object, records, text } from "./files.js";
import type { GrokBotRecipe } from "./recipe.js";
import type {
  GrokCredentialSelector,
  GrokMcpServer,
  GrokSourceAgent,
  GrokSourceSection,
} from "./types.js";

export function complete<T>(value: T): GrokSourceSection<T> {
  return { status: "complete", value };
}

export function unavailable<T>(value: T, reason: string): GrokSourceSection<T> {
  return { status: "unavailable", value, reason };
}

export function sourceId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function recipeAgent(recipe: GrokBotRecipe, id: string): GrokSourceAgent {
  return {
    id,
    name: recipe.profile.name,
    instructions: recipe.profile.description,
    title: recipe.profile.title,
    gettingStarted: recipe.gettingStarted,
    avatar: { shape: recipe.profile.avatarShape, color: recipe.profile.avatarColor },
    memory: complete(recipe.memory),
    skills: complete(recipe.skills),
    automations: complete(
      recipe.routines.map((routine) => ({
        id: routine.slug,
        name: routine.name,
        record: { recipeContent: routine.content, description: routine.description },
      })),
    ),
    plugins: complete(recipe.plugins),
  };
}

/** Retain verified settings fields; account stores and embedded credentials never enter a plan. */
export function safeSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of [
    "mainAgentId",
    "userTimeZone",
    "userTimeZoneOverride",
    "timeZone",
    "timezone",
    "computerUseModel",
    "toolPermissions",
    "localToolPermission",
    "localToolPermissionCeiling",
    "localToolPermissionByMachineId",
    "localEgressAllowed",
    "pinnedAgents",
    "sidebarSections",
    "emailProvider",
    "xToolAccess",
    "mcpBoxServers",
    "autoReviewInstructions",
    "mcpCustomInstructions",
    "mcpCustomInstructionsByServerId",
    "mcpDisabledToolsByServerId",
    "customInstructionsByName",
    "mcpToolPermissions",
    "pinnedAgentIds",
    "sidebarOrder",
  ]) {
    if (raw[key] !== undefined) {
      clean[key] = raw[key];
    }
  }
  if (raw.servers !== undefined) {
    clean.servers = records(raw.servers).map((row) => ({
      serverId: row.serverId,
      customInstructions: row.customInstructions,
      disabledTools: row.disabledTools,
    }));
  }
  return clean;
}

function portableMcpConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of [
    "command",
    "args",
    "url",
    "cwd",
    "type",
    "transport",
    "timeout",
    "timeoutMs",
  ]) {
    if (raw[key] !== undefined) {
      clean[key] = raw[key];
    }
  }
  // Embedded credentials cannot be reconstructed safely from a plan. Keep a
  // marker for manual configuration, never their values or partial commands.
  const credentialValues = [
    ...Object.values(object(raw.env) ?? {}),
    ...Object.values(object(raw.headers) ?? {}),
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.length >= 4 && !/^\*+$|^<redacted>$/iu.test(value),
  );
  const args = Array.isArray(raw.args) ? raw.args : [];
  const hasSecretArgument = args.some(
    (arg) =>
      typeof arg === "string" &&
      (/^--?(?:[\w-]*[-_])?(?:token|secret|password|api[-_]?key|authorization)(?:=|$)/iu.test(
        arg,
      ) ||
        credentialValues.some((secret) => arg.includes(secret))),
  );
  let embeddedUrl = false;
  if (typeof raw.url === "string") {
    try {
      const url = new URL(raw.url);
      embeddedUrl = Boolean(url.username || url.password || url.search || url.hash);
    } catch {
      /* Invalid URLs are rejected by the destination planner. */
    }
  }
  if (
    hasSecretArgument ||
    embeddedUrl ||
    (typeof raw.command === "string" && /\s/u.test(raw.command))
  ) {
    delete clean.command;
    delete clean.args;
    delete clean.url;
    clean.unsupportedEmbeddedCredentials = true;
  }
  if (
    raw.auth !== undefined ||
    raw.oauth !== undefined ||
    raw.authorization !== undefined ||
    raw.sourceAuthenticationRequired === true
  ) {
    clean.sourceAuthenticationRequired = true;
  }
  if (raw.unsupportedEmbeddedCredentials === true) {
    clean.unsupportedEmbeddedCredentials = true;
  }
  return clean;
}

/** Credentials are represented only by locations, including redacted live MCP fields. */
export function mcpServers(config: unknown, sourcePath: string, live = false): GrokMcpServer[] {
  const servers = object(object(config)?.mcpServers);
  if (!servers) {
    throw new Error("Grok MCP configuration must contain mcpServers.");
  }
  return Object.entries(servers).map(([name, value]) => {
    const raw = object(value);
    if (!raw) {
      throw new Error("Grok MCP server configuration is invalid.");
    }
    const clean = portableMcpConfig(raw);
    const credentialSelectors: GrokCredentialSelector[] = [];
    for (const field of ["env", "headers"]) {
      const values = object(raw[field]);
      if (!values) {
        continue;
      }
      for (const key of Object.keys(values)) {
        const path = ["mcpServers", name, field, key];
        credentialSelectors.push({
          id: `mcp:${sourceId(JSON.stringify(path))}`,
          name: key,
          kind: live ? "mcp-secret" : "snapshot-secret",
          sourcePath,
          path,
        });
      }
    }
    return {
      name,
      config: clean,
      credentialSelectors: clean.sourceAuthenticationRequired ? [] : credentialSelectors,
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    };
  });
}

export function applyMcpSettings(
  servers: GrokMcpServer[],
  settings: Record<string, unknown>,
  metadata: unknown,
): void {
  const ids = object(metadata) ?? {};
  const byName =
    object(settings.customInstructionsByName) ?? object(settings.mcpCustomInstructions) ?? {};
  const byId = object(settings.mcpCustomInstructionsByServerId) ?? {};
  const disabledById = object(settings.mcpDisabledToolsByServerId) ?? {};
  const rows = records(settings.servers);
  for (const server of servers) {
    const entry = object(ids[server.name]);
    const id = text(entry?.serverId) ?? text(ids[server.name]);
    const row = rows.find((candidate) => candidate.serverId === id);
    server.instructions =
      text(row?.customInstructions) ?? text(id ? byId[id] : undefined) ?? text(byName[server.name]);
    const disabled = row?.disabledTools ?? (id ? disabledById[id] : undefined);
    if (Array.isArray(disabled) && disabled.every((tool) => typeof tool === "string")) {
      server.disabledTools = disabled;
    }
  }
}
