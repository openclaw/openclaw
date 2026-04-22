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
 * Broader placeholder check used for fail-closed gates: returns `true` for
 * any `{word}` placeholder, not just the four known tokens. Callers that
 * must treat unknown placeholders (typos like `{tenant}` or
 * `{workspaceDIR}`) the same as known templated paths — for example the
 * plugin registration code that decides whether to skip memory-corpus /
 * prompt-section supplements — should gate on this instead of
 * {@link containsVaultPathTemplate}.
 */
export function hasAnyVaultPathPlaceholder(candidatePath: string): boolean {
  return VAULT_PATH_ANY_PLACEHOLDER.test(candidatePath);
}

/**
 * Expand `{workspaceDir}`, `{agentDir}`, `{agentId}`, `{sessionKey}` placeholders
 * in a vault path using the supplied tool invocation context. Throws if the
 * expanded path still contains any `{...}` placeholder — either because a
 * known token's context value was absent (e.g. `{workspaceDir}` invoked from
 * a plugin tool server that only passes `{ config }`) or because the template
 * referenced an unknown token (e.g. a typo like `{tenant}`). Returning the
 * unresolved path string is not fail-closed: `fs.mkdir(path, { recursive: true })`
 * happily creates a directory named literally `{workspaceDir}` under
 * `process.cwd()` and subsequent writes succeed against a CWD-backed vault,
 * which can mix data across sessions or tenants. Throwing at this layer
 * surfaces the misconfiguration at tool invocation time — before any
 * filesystem side effect runs — instead of waiting for a read ENOENT that
 * never fires on the recursive-create write path.
 *
 * Successful expansions are normalized so path-traversal segments (e.g.
 * `..`) collapse against resolved segments as usual.
 */
export function expandVaultPathTemplate(
  templatePath: string,
  ctx: VaultPathTemplateContext,
): string {
  // Short-circuit on paths with no `{...}` placeholder AT ALL. The broader
  // check is required — gating on the narrow four-known-tokens regex would
  // let a path like `"{tenant}/wiki"` or a typo like `"{workspaceDIR}/wiki"`
  // skip the unresolved-placeholder guard below and be returned as a literal
  // string, which would then hit `fs.mkdir(..., { recursive: true })` in the
  // write flow and create a brace-named directory under CWD.
  if (!VAULT_PATH_ANY_PLACEHOLDER.test(templatePath)) {
    return templatePath;
  }
  const expanded = templatePath.replace(
    VAULT_PATH_TEMPLATE_PATTERN,
    (match, token: (typeof VAULT_PATH_TEMPLATE_TOKENS)[number]) => {
      const value = ctx[token];
      return value != null && value !== "" ? value : match;
    },
  );
  const unresolved = expanded.match(new RegExp(VAULT_PATH_ANY_PLACEHOLDER, "g"));
  if (unresolved) {
    const uniquePlaceholders = [...new Set(unresolved)].toSorted();
    throw new Error(
      `memory-wiki vault.path has unresolved placeholder(s) ${uniquePlaceholders.join(", ")} in "${templatePath}" — invocation context did not provide the required value(s). Supply a literal path or invoke from a context that populates the referenced tokens.`,
    );
  }
  return path.normalize(expanded);
}

/**
 * Return a {@link ResolvedMemoryWikiConfig} with `vault.path` expanded against
 * the supplied invocation context. If the path contains no `{...}`
 * placeholder at all the input config is returned unchanged (identity) so
 * the fast path allocates nothing. The check uses the broader any-placeholder
 * regex so unknown placeholders (typos like `{tenant}` / `{workspaceDIR}`)
 * still flow through `expandVaultPathTemplate` and surface as a config error
 * instead of silently being returned as a literal vault path.
 */
export function resolveMemoryWikiConfigForCtx(
  base: ResolvedMemoryWikiConfig,
  ctx: VaultPathTemplateContext,
): ResolvedMemoryWikiConfig {
  if (!VAULT_PATH_ANY_PLACEHOLDER.test(base.vault.path)) {
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
