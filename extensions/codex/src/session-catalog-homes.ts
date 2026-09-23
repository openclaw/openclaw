import fs from "node:fs/promises";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import {
  listAgentIds,
  resolveAgentDir,
  resolveSessionAgentIdsStrict,
} from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { canonicalPathFromExistingAncestor } from "openclaw/plugin-sdk/file-access-runtime";
import {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
  resolveCodexAppServerUserHomeDir,
} from "./app-server/auth-start-options.js";
import { setCodexCatalogConnectionHomeResolver } from "./app-server/binding-connection.js";
import { readCodexPluginConfig } from "./app-server/config-parsing.js";
import type { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { codexCatalogHomeIdFromCanonicalPath } from "./session-catalog-home-id.js";
import {
  CatalogParamsError,
  CODEX_LOCAL_SESSION_HOST_ID,
  MAX_HOST_COUNT,
} from "./session-catalog-parsing.js";
import type { CodexCatalogHome } from "./session-catalog-types.js";

export type { CodexCatalogHome } from "./session-catalog-types.js";

type CatalogHomeCandidate = {
  codexHome: string;
  label: string;
  usesProcessHomeFallback?: boolean;
};

type CatalogGeneration = {
  config: OpenClawConfig;
  assertCurrent(): void;
  pluginConfig: unknown;
  agentIds?: string[];
  agentDirs: Map<string, string>;
  paths: Map<string, string | Promise<string>>;
  directories: Set<string>;
  candidates?: CatalogHomeCandidate[] | Promise<CatalogHomeCandidate[]>;
};

type CodexNodeHome = Pick<
  CodexCatalogHome,
  "appServer" | "localSessionsRoot" | "sourceHomeId" | "assertCurrent"
> & {
  codexHome: string;
  agentId?: string;
  agentDir?: string;
};

/** Discovers path facts on demand; runtime projections belong only to their requesting owner. */
export function createCodexCatalogHomeResolver(params: {
  config: OpenClawConfig;
  getRuntimeConfig: () => OpenClawConfig | undefined;
  getPluginConfig: () => unknown;
  resolveRuntimeOptions: typeof resolveCodexSupervisionAppServerRuntimeOptions;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  const generations = new WeakMap<OpenClawConfig, CatalogGeneration>();
  let lastConfig = params.config;
  const currentConfig = () => (lastConfig = params.getRuntimeConfig() ?? lastConfig);
  const generation = () => {
    const config = currentConfig();
    let current = generations.get(config);
    if (!current) {
      current = {
        config,
        assertCurrent: () => {
          if (currentConfig() !== config) {
            throw new CatalogParamsError(
              "Codex session catalog configuration changed; retry the request",
            );
          }
        },
        pluginConfig: params.getPluginConfig(),
        agentDirs: new Map(),
        paths: new Map(),
        directories: new Set(),
      };
      generations.set(config, current);
    }
    return current;
  };
  const agentIds = (snapshot: CatalogGeneration) =>
    (snapshot.agentIds ??= listAgentIds(snapshot.config).toSorted((a, b) => a.localeCompare(b)));
  const agentDir = (snapshot: CatalogGeneration, agentId: string) => {
    let directory = snapshot.agentDirs.get(agentId);
    if (!directory) {
      directory = resolveAgentDir(snapshot.config, agentId, env);
      snapshot.agentDirs.set(agentId, directory);
    }
    return directory;
  };
  const homePath = async (snapshot: CatalogGeneration, value: string): Promise<string> => {
    const cached = snapshot.paths.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = path.resolve(value);
    const discovery = canonicalPathFromExistingAncestor(resolved)
      .catch(() => resolved)
      .then(async (canonical) => {
        if (
          await fs.stat(canonical).then(
            (stat) => stat.isDirectory(),
            () => false,
          )
        ) {
          snapshot.directories.add(value);
        }
        snapshot.paths.set(value, canonical);
        return canonical;
      });
    snapshot.paths.set(value, discovery);
    return discovery;
  };
  const sharedCandidates = (snapshot: CatalogGeneration) =>
    (snapshot.candidates ??= (async () => {
      const candidates: CatalogHomeCandidate[] = [];
      const seen = new Set<string>();
      const append = async (value: string, label?: string) => {
        const codexHome = await homePath(snapshot, value);
        if (!snapshot.directories.has(value) || seen.has(codexHome)) {
          return;
        }
        seen.add(codexHome);
        candidates.push({ codexHome, label: `Local Codex · ${label ?? path.basename(codexHome)}` });
      };
      for (const id of agentIds(snapshot)) {
        // The SDK registers directory identity synchronously. Resolve at most one per task.
        await scheduler.yield();
        const directory = await homePath(snapshot, agentDir(snapshot, id));
        await append(resolveCodexAppServerHomeDir(directory), id);
        if (candidates.length === MAX_HOST_COUNT) {
          return candidates;
        }
      }
      for (const entry of readCodexPluginConfig(snapshot.pluginConfig).sessionCatalog?.homes ??
        []) {
        await scheduler.yield();
        const { path: home, label } = typeof entry === "string" ? { path: entry } : entry;
        await append(home, label);
        if (candidates.length === MAX_HOST_COUNT) {
          break;
        }
      }
      return candidates;
    })().then(
      // Retain facts, not the discovering request's async context.
      (candidates) => (snapshot.candidates = candidates),
      (error: unknown) => {
        snapshot.candidates = undefined;
        throw error;
      },
    ));

  const prepareAgentHomes = async (
    snapshot: CatalogGeneration,
    agentId: string,
    fleet: boolean,
  ) => {
    await scheduler.yield();
    snapshot.assertCurrent();
    if (!agentIds(snapshot).includes(agentId)) {
      return [];
    }
    const ownerAgentDir = await homePath(snapshot, agentDir(snapshot, agentId));
    const base = params.resolveRuntimeOptions({
      config: snapshot.config,
      pluginConfig: snapshot.pluginConfig,
      agentDir: ownerAgentDir,
      env,
    });
    const processHomeConfigured = Boolean(env.CODEX_HOME?.trim());
    const candidates: CatalogHomeCandidate[] = [
      {
        codexHome: await homePath(
          snapshot,
          resolveCodexAppServerLocalHomeDir(base.start, ownerAgentDir, env),
        ),
        label: "Local Codex",
        usesProcessHomeFallback:
          base.start.transport === "stdio" &&
          base.start.homeScope === "user" &&
          !processHomeConfigured,
      },
    ];
    if (fleet && base.start.transport === "stdio") {
      candidates.push({
        codexHome: await homePath(snapshot, resolveCodexAppServerUserHomeDir(env)),
        label: "Local Codex · user",
        usesProcessHomeFallback: !processHomeConfigured,
      });
      const ownerHome = resolveCodexAppServerHomeDir(ownerAgentDir);
      const codexHome = await homePath(snapshot, ownerHome);
      if (snapshot.directories.has(ownerHome)) {
        candidates.push({ codexHome, label: `Local Codex · ${agentId}` });
      }
      candidates.push(...(await sharedCandidates(snapshot)));
    }
    snapshot.assertCurrent();
    const homes: CodexCatalogHome[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate.codexHome)) {
        continue;
      }
      seen.add(candidate.codexHome);
      const sourceHomeId = codexCatalogHomeIdFromCanonicalPath(candidate.codexHome);
      const primary = homes.length === 0;
      homes.push({
        assertCurrent: snapshot.assertCurrent.bind(snapshot),
        sourceHomeId,
        hostId: primary
          ? CODEX_LOCAL_SESSION_HOST_ID
          : `${CODEX_LOCAL_SESSION_HOST_ID}:${sourceHomeId}`,
        label: candidate.label,
        agentDir: ownerAgentDir,
        appServer:
          base.start.transport !== "stdio"
            ? base
            : {
                ...base,
                start: {
                  ...base.start,
                  codexHome: candidate.codexHome,
                  ...(!primary
                    ? {
                        homeScope: "user" as const,
                        env: { ...base.start.env, CODEX_HOME: candidate.codexHome },
                      }
                    : {}),
                },
              },
        ...(base.connectionClass === "remote"
          ? {}
          : { localSessionsRoot: path.join(candidate.codexHome, "sessions") }),
        usesProcessHomeFallback: candidate.usesProcessHomeFallback ?? false,
      });
      if (homes.length === MAX_HOST_COUNT) {
        break;
      }
    }
    return homes;
  };

  setCodexCatalogConnectionHomeResolver(async (directory) => {
    const snapshot = generation();
    for (const id of agentIds(snapshot)) {
      await scheduler.yield();
      if (agentDir(snapshot, id) === directory) {
        return prepareAgentHomes(snapshot, id, true);
      }
    }
    snapshot.assertCurrent();
    return [];
  });

  return {
    forAgent: (agentId: string) => prepareAgentHomes(generation(), agentId, true),
    async forNode(requestedAgentId?: string): Promise<CodexNodeHome> {
      const snapshot = generation();
      const configured = readCodexPluginConfig(snapshot.pluginConfig).appServer;
      if (
        configured?.homeScope === "agent" ||
        (configured?.transport && configured.transport !== "stdio")
      ) {
        // Released explicit node sources retain their agent-qualified selector.
        const agentId = resolveSessionAgentIdsStrict({
          config: snapshot.config,
          agentId: requestedAgentId,
        }).sessionAgentId;
        const source = (await prepareAgentHomes(snapshot, agentId, false))[0];
        if (!source) {
          throw new CatalogParamsError(`unknown Codex session catalog agent: ${agentId}`);
        }
        return {
          ...source,
          agentId,
          codexHome: resolveCodexAppServerLocalHomeDir(
            source.appServer.start,
            source.agentDir,
            env,
          ),
        };
      }
      const codexHome = await homePath(snapshot, resolveCodexAppServerUserHomeDir(env));
      snapshot.assertCurrent();
      const appServer = params.resolveRuntimeOptions({
        pluginConfig: snapshot.pluginConfig,
        config: snapshot.config,
        env,
      });
      return {
        assertCurrent: snapshot.assertCurrent.bind(snapshot),
        sourceHomeId: codexCatalogHomeIdFromCanonicalPath(codexHome),
        codexHome,
        localSessionsRoot: path.join(codexHome, "sessions"),
        appServer: {
          ...appServer,
          start: { ...appServer.start, env: { ...appServer.start.env, CODEX_HOME: codexHome } },
        },
      };
    },
  };
}
