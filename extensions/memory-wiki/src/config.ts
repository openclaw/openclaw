// Memory Wiki helper module supports config behavior.
import os from "node:os";
import path from "node:path";
import { mapPluginConfigIssues } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveAgentMemoryExtensionConfig,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { buildPluginConfigSchema, z, type OpenClawPluginConfigSchema } from "../api.js";
import type { OpenClawConfig } from "../api.js";

export const WIKI_VAULT_MODES = ["isolated", "bridge", "unsafe-local"] as const;
export const WIKI_RENDER_MODES = ["native", "obsidian"] as const;
export const WIKI_SEARCH_BACKENDS = ["shared", "local"] as const;
export const WIKI_SEARCH_CORPORA = ["wiki", "memory", "all"] as const;

export type WikiVaultMode = (typeof WIKI_VAULT_MODES)[number];
export type WikiRenderMode = (typeof WIKI_RENDER_MODES)[number];
export type WikiSearchBackend = (typeof WIKI_SEARCH_BACKENDS)[number];
export type WikiSearchCorpus = (typeof WIKI_SEARCH_CORPORA)[number];

export type MemoryWikiPluginConfig = {
  vaultMode?: WikiVaultMode;
  vault?: {
    path?: string;
    renderMode?: WikiRenderMode;
  };
  obsidian?: {
    enabled?: boolean;
    useOfficialCli?: boolean;
    vaultName?: string;
    openAfterWrites?: boolean;
  };
  bridge?: {
    enabled?: boolean;
    readMemoryArtifacts?: boolean;
    indexDreamReports?: boolean;
    indexDailyNotes?: boolean;
    indexMemoryRoot?: boolean;
    followMemoryEvents?: boolean;
  };
  unsafeLocal?: {
    allowPrivateMemoryCoreAccess?: boolean;
    paths?: string[];
  };
  ingest?: {
    autoCompile?: boolean;
    maxConcurrentJobs?: number;
    allowUrlIngest?: boolean;
  };
  search?: {
    backend?: WikiSearchBackend;
    corpus?: WikiSearchCorpus;
  };
  context?: {
    includeCompiledDigestPrompt?: boolean;
  };
  render?: {
    preserveHumanBlocks?: boolean;
    createBacklinks?: boolean;
    createDashboards?: boolean;
  };
};

export type ResolvedMemoryWikiConfig = {
  agentId?: string;
  vaultMode: WikiVaultMode;
  vault: {
    path: string;
    renderMode: WikiRenderMode;
  };
  obsidian: {
    enabled: boolean;
    useOfficialCli: boolean;
    vaultName?: string;
    openAfterWrites: boolean;
  };
  bridge: {
    enabled: boolean;
    readMemoryArtifacts: boolean;
    indexDreamReports: boolean;
    indexDailyNotes: boolean;
    indexMemoryRoot: boolean;
    followMemoryEvents: boolean;
  };
  unsafeLocal: {
    allowPrivateMemoryCoreAccess: boolean;
    paths: string[];
  };
  ingest: {
    autoCompile: boolean;
    maxConcurrentJobs: number;
    allowUrlIngest: boolean;
  };
  search: {
    backend: WikiSearchBackend;
    corpus: WikiSearchCorpus;
  };
  context: {
    includeCompiledDigestPrompt: boolean;
  };
  render: {
    preserveHumanBlocks: boolean;
    createBacklinks: boolean;
    createDashboards: boolean;
  };
};

export const DEFAULT_WIKI_VAULT_MODE: WikiVaultMode = "isolated";
export const DEFAULT_WIKI_RENDER_MODE: WikiRenderMode = "native";
export const DEFAULT_WIKI_SEARCH_BACKEND: WikiSearchBackend = "shared";
export const DEFAULT_WIKI_SEARCH_CORPUS: WikiSearchCorpus = "wiki";

const MemoryWikiConfigSource = z.strictObject({
  vaultMode: z.enum(WIKI_VAULT_MODES).optional(),
  vault: z
    .strictObject({
      path: z.string().optional(),
      renderMode: z.enum(WIKI_RENDER_MODES).optional(),
    })
    .optional(),
  obsidian: z
    .strictObject({
      enabled: z.boolean().optional(),
      useOfficialCli: z.boolean().optional(),
      vaultName: z.string().optional(),
      openAfterWrites: z.boolean().optional(),
    })
    .optional(),
  bridge: z
    .strictObject({
      enabled: z.boolean().optional(),
      readMemoryArtifacts: z.boolean().optional(),
      indexDreamReports: z.boolean().optional(),
      indexDailyNotes: z.boolean().optional(),
      indexMemoryRoot: z.boolean().optional(),
      followMemoryEvents: z.boolean().optional(),
    })
    .optional(),
  unsafeLocal: z
    .strictObject({
      allowPrivateMemoryCoreAccess: z.boolean().optional(),
      paths: z.array(z.string()).optional(),
    })
    .optional(),
  ingest: z
    .strictObject({
      autoCompile: z.boolean().optional(),
      maxConcurrentJobs: z.number().int().min(1).optional(),
      allowUrlIngest: z.boolean().optional(),
    })
    .optional(),
  search: z
    .strictObject({
      backend: z.enum(WIKI_SEARCH_BACKENDS).optional(),
      corpus: z.enum(WIKI_SEARCH_CORPORA).optional(),
    })
    .optional(),
  context: z
    .strictObject({
      includeCompiledDigestPrompt: z.boolean().optional(),
    })
    .optional(),
  render: z
    .strictObject({
      preserveHumanBlocks: z.boolean().optional(),
      createBacklinks: z.boolean().optional(),
      createDashboards: z.boolean().optional(),
    })
    .optional(),
});

const memoryWikiConfigSchemaBase = buildPluginConfigSchema(MemoryWikiConfigSource, {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: resolveMemoryWikiConfig(undefined) };
    }
    const result = MemoryWikiConfigSource.safeParse(value);
    if (result.success) {
      return { success: true, data: resolveMemoryWikiConfig(result.data) };
    }
    return {
      success: false,
      error: {
        issues: mapPluginConfigIssues(result.error.issues),
      },
    };
  },
});

export const memoryWikiConfigSchema: OpenClawPluginConfigSchema = memoryWikiConfigSchemaBase;

function expandHomePath(inputPath: string, homedir: string): string {
  if (inputPath === "~") {
    return homedir;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(homedir, inputPath.slice(2));
  }
  return inputPath;
}

export function resolveDefaultMemoryWikiVaultPath(
  homedir = os.homedir(),
  agentId = "main",
): string {
  return path.join(homedir, ".openclaw", "wiki", agentId);
}

function parseMemoryWikiConfig(
  config: MemoryWikiPluginConfig | undefined,
): z.infer<typeof MemoryWikiConfigSource> {
  if (config === undefined) {
    return {};
  }
  const parsed = MemoryWikiConfigSource.safeParse(config);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = mapPluginConfigIssues(parsed.error.issues)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid memory-wiki config: ${issues}`);
}

export function resolveMemoryWikiConfig(
  config: MemoryWikiPluginConfig | undefined,
  options?: { homedir?: string; agentId?: string },
): ResolvedMemoryWikiConfig {
  const homedir = options?.homedir ?? os.homedir();
  const agentId = options?.agentId ? normalizeAgentId(options.agentId) : undefined;
  const safeConfig = parseMemoryWikiConfig(config);

  return {
    ...(agentId ? { agentId } : {}),
    vaultMode: safeConfig.vaultMode ?? DEFAULT_WIKI_VAULT_MODE,
    vault: {
      path: expandHomePath(
        safeConfig.vault?.path ?? resolveDefaultMemoryWikiVaultPath(homedir, agentId),
        homedir,
      ),
      renderMode: safeConfig.vault?.renderMode ?? DEFAULT_WIKI_RENDER_MODE,
    },
    obsidian: {
      enabled: safeConfig.obsidian?.enabled ?? false,
      useOfficialCli: safeConfig.obsidian?.useOfficialCli ?? false,
      ...(safeConfig.obsidian?.vaultName ? { vaultName: safeConfig.obsidian.vaultName } : {}),
      openAfterWrites: safeConfig.obsidian?.openAfterWrites ?? false,
    },
    bridge: {
      enabled: safeConfig.bridge?.enabled ?? false,
      readMemoryArtifacts: safeConfig.bridge?.readMemoryArtifacts ?? true,
      indexDreamReports: safeConfig.bridge?.indexDreamReports ?? true,
      indexDailyNotes: safeConfig.bridge?.indexDailyNotes ?? true,
      indexMemoryRoot: safeConfig.bridge?.indexMemoryRoot ?? true,
      followMemoryEvents: safeConfig.bridge?.followMemoryEvents ?? true,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: safeConfig.unsafeLocal?.allowPrivateMemoryCoreAccess ?? false,
      paths: safeConfig.unsafeLocal?.paths ?? [],
    },
    ingest: {
      autoCompile: safeConfig.ingest?.autoCompile ?? true,
      maxConcurrentJobs: safeConfig.ingest?.maxConcurrentJobs ?? 1,
      allowUrlIngest: safeConfig.ingest?.allowUrlIngest ?? true,
    },
    search: {
      backend: safeConfig.search?.backend ?? DEFAULT_WIKI_SEARCH_BACKEND,
      corpus: safeConfig.search?.corpus ?? DEFAULT_WIKI_SEARCH_CORPUS,
    },
    context: {
      includeCompiledDigestPrompt: safeConfig.context?.includeCompiledDigestPrompt ?? false,
    },
    render: {
      preserveHumanBlocks: safeConfig.render?.preserveHumanBlocks ?? true,
      createBacklinks: safeConfig.render?.createBacklinks ?? true,
      createDashboards: safeConfig.render?.createDashboards ?? true,
    },
  };
}

/** Resolves canonical memory-wiki config for one agent. */
export function resolveMemoryWikiConfigForAgent(
  appConfig: OpenClawConfig,
  agentId?: string,
  options?: { homedir?: string },
): ResolvedMemoryWikiConfig {
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(appConfig));
  const config = resolveAgentMemoryExtensionConfig(appConfig, resolvedAgentId, "memory-wiki") as
    | MemoryWikiPluginConfig
    | undefined;
  return resolveMemoryWikiConfig(config, { ...options, agentId: resolvedAgentId });
}
