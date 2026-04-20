import os from "node:os";
import path from "node:path";
import { buildPluginConfigSchema, z, type OpenClawPluginConfigSchema } from "../api.js";

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
        issues: result.error.issues.map((issue) => ({
          path: issue.path.filter((segment): segment is string | number => {
            const kind = typeof segment;
            return kind === "string" || kind === "number";
          }),
          message: issue.message,
        })),
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

export function resolveDefaultMemoryWikiVaultPath(homedir = os.homedir()): string {
  return path.join(homedir, ".openclaw", "wiki", "main");
}

/**
 * Context fields available for `vault.path` template expansion. All fields are
 * optional; missing values expand to an empty string so callers can detect
 * unresolved templates via {@link containsVaultPathTemplate}.
 */
export type VaultPathTemplateContext = {
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
};

const VAULT_PATH_TEMPLATE_TOKENS = ["workspaceDir", "agentDir", "agentId", "sessionKey"] as const;

const VAULT_PATH_TEMPLATE_DETECT = new RegExp(`\\{(${VAULT_PATH_TEMPLATE_TOKENS.join("|")})\\}`);

const VAULT_PATH_TEMPLATE_PATTERN = new RegExp(
  `\\{(${VAULT_PATH_TEMPLATE_TOKENS.join("|")})\\}`,
  "g",
);

// Broader check used after expansion to gate `path.normalize`. Matches any
// `{word}` placeholder, not just the four known tokens, so a typo like
// `{tenant}` in a multi-tenant config still blocks normalization — otherwise
// `path.normalize("/tmp/workspace/{tenant}/../wiki")` collapses to
// `/tmp/workspace/wiki` and silently redirects the vault.
const VAULT_PATH_ANY_PLACEHOLDER = /\{[^{}/]+\}/;

export function containsVaultPathTemplate(candidatePath: string): boolean {
  return VAULT_PATH_TEMPLATE_DETECT.test(candidatePath);
}

/**
 * Expand `{workspaceDir}`, `{agentDir}`, `{agentId}`, `{sessionKey}` placeholders
 * in a vault path using the supplied tool invocation context. Tokens whose
 * context value is absent (or empty) are preserved literally in the output
 * (e.g. `{workspaceDir}/wiki` stays `{workspaceDir}/wiki`) so downstream
 * filesystem operations fail visibly instead of silently collapsing the path
 * into a different tenant's vault, the process CWD, or the filesystem root —
 * for example when a plugin tool server resolves tools with a context that
 * does not populate workspace/agent/session fields.
 *
 * Normalization is only applied when every placeholder was resolved. Running
 * `path.normalize` over a path that still contains `{...}` segments would
 * collapse traversal that references those segments —
 * `path.normalize("{workspaceDir}/../wiki")` returns `"wiki"`, a CWD-relative
 * path — re-introducing the exact silent-redirect failure mode the literal
 * preservation guards against. The gate uses a broader `\{word\}` match
 * (not just the four known tokens), so typos like `{tenant}` also block
 * normalization and fail loudly at the filesystem layer instead of silently
 * redirecting to a neighbouring tenant.
 */
export function expandVaultPathTemplate(
  templatePath: string,
  ctx: VaultPathTemplateContext,
): string {
  if (!containsVaultPathTemplate(templatePath)) {
    return templatePath;
  }
  const expanded = templatePath.replace(
    VAULT_PATH_TEMPLATE_PATTERN,
    (match, token: (typeof VAULT_PATH_TEMPLATE_TOKENS)[number]) => {
      const value = ctx[token];
      return value != null && value !== "" ? value : match;
    },
  );
  if (VAULT_PATH_ANY_PLACEHOLDER.test(expanded)) {
    return expanded;
  }
  return path.normalize(expanded);
}

/**
 * Return a {@link ResolvedMemoryWikiConfig} with `vault.path` expanded against
 * the supplied invocation context. If the path has no template tokens the
 * input config is returned unchanged (identity) so the fast path allocates
 * nothing.
 */
export function resolveMemoryWikiConfigForCtx(
  base: ResolvedMemoryWikiConfig,
  ctx: VaultPathTemplateContext,
): ResolvedMemoryWikiConfig {
  if (!containsVaultPathTemplate(base.vault.path)) {
    return base;
  }
  return {
    ...base,
    vault: {
      ...base.vault,
      path: expandVaultPathTemplate(base.vault.path, ctx),
    },
  };
}

export function resolveMemoryWikiConfig(
  config: MemoryWikiPluginConfig | undefined,
  options?: { homedir?: string },
): ResolvedMemoryWikiConfig {
  const homedir = options?.homedir ?? os.homedir();
  const parsed = config ? MemoryWikiConfigSource.safeParse(config) : null;
  const safeConfig = parsed?.success ? parsed.data : (config ?? {});

  return {
    vaultMode: safeConfig.vaultMode ?? DEFAULT_WIKI_VAULT_MODE,
    vault: {
      path: expandHomePath(
        safeConfig.vault?.path ?? resolveDefaultMemoryWikiVaultPath(homedir),
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
