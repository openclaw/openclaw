import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveGrokBotAccessToken } from "./auth.js";
import { exists, object, readJson, records, text } from "./files.js";
import { readHostedInventory, requestGrok } from "./hosted.js";
import { discoverGrokBotRoster } from "./local.js";
import {
  complete,
  mcpServers,
  recipeAgent,
  safeSettings,
  sourceId,
  unavailable,
} from "./normalize.js";
import { parseGrokBotRecipe } from "./recipe.js";
import { listLocalCredentialSelectors } from "./secrets.js";
import {
  applySnapshotMcpMetadata,
  snapshotAvatar,
  snapshotIssues,
  snapshotSection,
  snapshotStatus,
} from "./snapshot-metadata.js";
import { parseGrokBotUrl, readGrokResponse, resolveGrokShareId } from "./transport.js";
import type { GrokSourceDetection, GrokSourceInventory, GrokSourceOptions } from "./types.js";

export type * from "./types.js";

function home(options: GrokSourceOptions): string {
  return options.homeDir ?? os.homedir();
}

function appRoot(options: GrokSourceOptions): string {
  return path.join(home(options), "Library/Application Support/Grok Bot");
}

// Tracks resolver identity only; no token or resolved promise is stored globally.
const sessionResolvers = new WeakSet<() => Promise<string>>();
function hasExplicitAccessToken(options: GrokSourceOptions): boolean {
  return Boolean(options.resolveAccessToken && !sessionResolvers.has(options.resolveAccessToken));
}

/** One explicit operation; failures are memoized too, avoiding repeated approval prompts. */
export function createGrokAccessTokenResolver(
  options: GrokSourceOptions = {},
): () => Promise<string> {
  let pending: Promise<string> | undefined;
  const resolve = () => {
    pending ??= (async () => {
      if (options.resolveAccessToken) {
        return options.resolveAccessToken();
      }
      const detection = await detectGrokSource(options);
      return resolveGrokBotAccessToken({
        homeDir: home(options),
        userDataDir: detection.kind === "local" ? detection.source : appRoot(options),
      });
    })();
    return pending;
  };
  sessionResolvers.add(resolve);
  return resolve;
}

export async function detectGrokSource(
  options: GrokSourceOptions = {},
): Promise<GrokSourceDetection> {
  const input = options.source?.trim();
  if (input === "live") {
    return {
      detected: true,
      source: "live",
      kind: "live",
      notes: ["Authenticated account read is deferred until migration planning."],
    };
  }
  if (input && /^[a-z][a-z0-9+.-]*:\/\//iu.test(input)) {
    parseGrokBotUrl(input);
    return {
      detected: true,
      source: input,
      kind: "url",
      notes: ["A template contains a bot snapshot, not complete account settings."],
    };
  }
  const source = input
    ? path.resolve(input.startsWith("~/") ? path.join(home(options), input.slice(2)) : input)
    : appRoot(options);
  if (await exists(source)) {
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) {
      throw new Error("Grok migration source must not be a symlink.");
    }
    if (stat.isFile()) {
      return {
        detected: true,
        source,
        kind: path.basename(source) === "grok-migration.json" ? "snapshot" : "recipe",
        notes: [],
      };
    }
    if (await exists(path.join(source, "grok-migration.json"))) {
      return { detected: true, source, kind: "snapshot", notes: [] };
    }
    if (
      (await exists(path.join(source, "sand-client-persistence"))) ||
      (await exists(path.join(source, "settings.json"))) ||
      (await exists(path.join(source, "sand-secrets.json")))
    ) {
      return { detected: true, source, kind: "local", notes: [] };
    }
  }
  const detected =
    !input &&
    (Boolean(hasExplicitAccessToken(options) || process.env.GROK_BOT_ACCESS_TOKEN) ||
      (await exists(path.join(home(options), ".grokbot/settings.json"))));
  return {
    detected,
    source: detected ? "live" : source,
    kind: detected ? "live" : "local",
    notes: detected
      ? []
      : ["Grok Bot data was not found. Supply its application directory or a migration snapshot."],
  };
}

function empty(source: string, kind: GrokSourceInventory["kind"]): GrokSourceInventory {
  return {
    source,
    kind,
    settings: unavailable({}, "Account settings were not included."),
    agents: unavailable([], "Agent definitions were not included."),
    mcpServers: unavailable([], "MCP definitions were not included."),
    credentials: [],
    issues: [],
  };
}

function fromRecipe(raw: Record<string, unknown>, source: string, id?: string) {
  return recipeAgent(parseGrokBotRecipe(JSON.stringify(raw)), id ?? `recipe-${sourceId(source)}`);
}

async function readSnapshot(detection: GrokSourceDetection): Promise<GrokSourceInventory> {
  const stat = await fs.lstat(detection.source);
  const file = stat.isDirectory()
    ? path.join(detection.source, "grok-migration.json")
    : detection.source;
  const raw = await readJson(file);
  if (raw.format !== "grok-migration") {
    const result = empty(detection.source, "recipe");
    result.agents = complete([fromRecipe(raw, detection.source)]);
    result.mainAgentId = result.agents.value[0]?.id;
    result.issues.push({
      code: "recipe_account_settings_unavailable",
      message:
        "This recipe supplies one bot; account configuration and connected credentials were not included.",
    });
    return result;
  }
  if (raw.version !== 1) {
    throw new Error("Unsupported Grok migration snapshot version.");
  }
  const result = empty(detection.source, "snapshot");
  result.mainAgentId = text(raw.mainAgentId);
  const settings = object(raw.settings);
  if (raw.settings !== undefined && !settings) {
    throw new Error("Invalid Grok snapshot settings.");
  }
  if (raw.agents !== undefined && !Array.isArray(raw.agents)) {
    throw new Error("Invalid Grok snapshot agents.");
  }
  if (settings) {
    result.settings = complete(safeSettings(settings));
    result.mainAgentId ??= text(settings.mainAgentId);
  }
  if (Array.isArray(raw.agents)) {
    result.agents = complete(
      records(raw.agents).map((row, index) => {
        // Missing content is recorded explicitly; an omitted memory array is not zero memories.
        if (row.id !== undefined && (typeof row.id !== "string" || !row.id.trim())) {
          throw new Error("Invalid Grok snapshot agent ID.");
        }
        const agent = fromRecipe(
          {
            ...row,
            memory: row.memory === undefined ? [] : row.memory,
            skills: row.skills === undefined ? [] : row.skills,
            routines: row.routines === undefined ? [] : row.routines,
            plugins: row.plugins === undefined ? [] : row.plugins,
          },
          file,
          text(row.id) ?? `snapshot-${index}`,
        );
        for (const field of ["memory", "skills", "plugins"] as const) {
          if (row[field] === undefined) {
            agent[field].status = "unavailable";
            agent[field].reason = `The snapshot omitted ${field}.`;
          }
        }
        if (row.automations !== undefined) {
          agent.automations = complete(
            records(row.automations).map((record, i) => ({
              id: text(record.id) ?? `automation-${i}`,
              name: text(record.name) ?? `Automation ${i + 1}`,
              record,
            })),
          );
        } else if (row.routines === undefined) {
          agent.automations = unavailable([], "The snapshot omitted automations.");
        }
        const status = snapshotStatus(row.sourceStatus);
        agent.memory = snapshotSection(agent.memory, status.memory, row.memory !== undefined);
        agent.skills = snapshotSection(agent.skills, status.skills, row.skills !== undefined);
        agent.plugins = snapshotSection(agent.plugins, status.plugins, row.plugins !== undefined);
        agent.automations = snapshotSection(
          agent.automations,
          status.automations,
          row.automations !== undefined || row.routines !== undefined,
        );
        const image = snapshotAvatar(row.avatarImage);
        if (image) {
          agent.avatar = { ...agent.avatar, image };
        }
        return agent;
      }),
    );
  }
  const ids = result.agents.value.map((agent) => agent.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Grok snapshot contains duplicate agent IDs.");
  }
  if (raw.mcpConfig !== undefined) {
    const servers = mcpServers(raw.mcpConfig, file);
    // The snapshot nests native MCP configuration under mcpConfig.
    for (const server of servers) {
      for (const selector of server.credentialSelectors) {
        selector.path?.unshift("mcpConfig");
      }
    }
    applySnapshotMcpMetadata(servers, raw.mcpMetadata);
    result.mcpServers = complete(servers);
    result.credentials.push(...servers.flatMap((server) => server.credentialSelectors));
  }
  if (Array.isArray(raw.credentialNames)) {
    for (const name of raw.credentialNames) {
      if (typeof name !== "string" || !name) {
        throw new Error("Invalid Grok snapshot credential name.");
      }
      result.credentials.push({
        id: `secret:${sourceId(name)}`,
        name,
        kind: "snapshot-secret",
        sourcePath: path.join(path.dirname(file), "secrets.json"),
        path: [name],
      });
    }
  }
  const status = snapshotStatus(raw.sourceStatus);
  result.settings = snapshotSection(result.settings, status.settings, raw.settings !== undefined);
  result.agents = snapshotSection(result.agents, status.agents, raw.agents !== undefined);
  result.mcpServers = snapshotSection(
    result.mcpServers,
    status.mcpServers,
    raw.mcpConfig !== undefined,
  );
  result.issues.push(...snapshotIssues(raw.sourceIssues));
  return result;
}

export async function readGrokSource(
  options: GrokSourceOptions = {},
): Promise<GrokSourceInventory> {
  const detection = await detectGrokSource(options);
  if (!detection.detected) {
    throw new Error(
      "Grok Bot source was not found. Supply its application directory or a migration snapshot.",
    );
  }
  if (detection.kind === "snapshot" || detection.kind === "recipe") {
    return readSnapshot(detection);
  }
  const resolveAccessToken = createGrokAccessTokenResolver(options);
  if (detection.kind === "url") {
    const shareId = await resolveGrokShareId(detection.source);
    const details = await requestGrok(
      await resolveAccessToken(),
      "GetGrokBotTemplateImportDetails",
      { shareId },
    );
    if (typeof details?.blobGetUrl !== "string") {
      throw new Error("Grok template did not provide a recipe download.");
    }
    const recipe = parseGrokBotRecipe(await readGrokResponse(details.blobGetUrl));
    const result = empty(detection.source, "url");
    result.agents = complete([recipeAgent(recipe, `template-${shareId}`)]);
    result.mainAgentId = result.agents.value[0]?.id;
    result.issues.push({
      code: "recipe_account_settings_unavailable",
      message:
        "This template supplies one bot; account configuration and connected credentials were not included.",
    });
    return result;
  }
  const root = detection.kind === "live" ? appRoot(options) : detection.source;
  const result = empty(detection.source, detection.kind);
  const settingsPath = (await exists(path.join(root, "settings.json")))
    ? path.join(root, "settings.json")
    : path.join(home(options), ".grokbot/settings.json");
  let accountScope: string | undefined;
  if (await exists(settingsPath)) {
    const settings = await readJson(settingsPath, 1024 * 1024);
    if (settings.version !== 1) {
      throw new Error("Unsupported Grok settings version.");
    }
    accountScope = text(settings.activeAccountScope);
    result.settings = complete(
      safeSettings({
        ...settings,
        ...object(accountScope ? object(settings.accountScopes)?.[accountScope] : undefined),
      }),
    );
    result.mainAgentId = text(result.settings.value.mainAgentId);
  }
  const roster = await discoverGrokBotRoster({ root });
  const cached = roster.accounts.flatMap((account) => account.agents);
  if (cached.length) {
    result.issues.push({
      code: "local_roster_metadata_only",
      message:
        "The local roster is metadata and may include rooms; hosted definitions are required to migrate agents.",
    });
  }
  try {
    result.credentials.push(...(await listLocalCredentialSelectors(root, accountScope)));
  } catch {
    result.issues.push({
      code: "source_credentials_unavailable",
      message:
        "Local user-secret metadata could not be read for the active account. Credentials require manual migration.",
    });
  }
  if (
    detection.kind === "live" ||
    hasExplicitAccessToken(options) ||
    process.env.GROK_BOT_ACCESS_TOKEN?.trim() ||
    (await exists(path.join(root, "sand-secrets.json")))
  ) {
    await readHostedInventory(result, resolveAccessToken);
  } else {
    result.issues.push({
      code: "source_sign_in_unavailable",
      message:
        "Sign in to Grok Bot to retrieve hosted agents and integrations, or supply an offline migration snapshot.",
    });
  }
  return result;
}
