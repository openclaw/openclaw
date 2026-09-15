// Memory Wiki plugin module implements apply behavior.
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { readFiniteNumberParam } from "openclaw/plugin-sdk/param-readers";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  asNonArrayRecord,
  normalizeStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { compileMemoryWikiVault, type CompileMemoryWikiResult } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  parseWikiMarkdown,
  renderWikiMarkdown,
  slugifyWikiPageStem,
  slugifyWikiSegment,
  normalizeSourceIds,
  normalizeWikiClaims,
  normalizeWikiRelationships,
  type WikiClaim,
  type WikiRelationship,
} from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import {
  readQueryableWikiPages,
  resolveQueryableWikiPageByLookup,
  type QueryableWikiPage,
} from "./query.js";
import { initializeMemoryWikiVault } from "./vault.js";

const GENERATED_START = "<!-- openclaw:wiki:generated:start -->";
const GENERATED_END = "<!-- openclaw:wiki:generated:end -->";
const HUMAN_START = "<!-- openclaw:human:start -->";
const HUMAN_END = "<!-- openclaw:human:end -->";

type CreatePageMemoryWikiMutationFields = {
  title: string;
  body: string;
  sourceIds: string[];
  claims?: WikiClaim[];
  contradictions?: string[];
  questions?: string[];
  confidence?: number;
  status?: string;
};

type CreateSynthesisMemoryWikiMutation = CreatePageMemoryWikiMutationFields & {
  op: "create_synthesis";
};

type CreateConceptMemoryWikiMutation = CreatePageMemoryWikiMutationFields & {
  op: "create_concept";
};

type CreateEntityMemoryWikiMutation = CreatePageMemoryWikiMutationFields & {
  op: "create_entity";
  entityType?: string;
  canonicalId?: string;
  aliases?: string[];
  relationships?: WikiRelationship[];
};

type CreatePageMemoryWikiMutation =
  | CreateSynthesisMemoryWikiMutation
  | CreateConceptMemoryWikiMutation
  | CreateEntityMemoryWikiMutation;

// Each create op owns one page directory, pageType, and id prefix; the
// directory is also how scans infer the page kind, so these must stay aligned.
const CREATE_PAGE_TARGETS: Record<
  CreatePageMemoryWikiMutation["op"],
  { dir: string; pageType: "synthesis" | "concept" | "entity" }
> = {
  create_synthesis: { dir: "syntheses", pageType: "synthesis" },
  create_concept: { dir: "concepts", pageType: "concept" },
  create_entity: { dir: "entities", pageType: "entity" },
};

type UpdateMetadataMemoryWikiMutation = {
  op: "update_metadata";
  lookup: string;
  sourceIds?: string[];
  claims?: WikiClaim[];
  contradictions?: string[];
  questions?: string[];
  confidence?: number | null;
  status?: string;
};

type ApplyMemoryWikiMutation = CreatePageMemoryWikiMutation | UpdateMetadataMemoryWikiMutation;

type ApplyMemoryWikiMutationResult = {
  changed: boolean;
  operation: ApplyMemoryWikiMutation["op"];
  pagePath: string;
  pageId?: string;
  compile: CompileMemoryWikiResult;
};

function normalizeMutationConfidence(
  params: Record<string, unknown>,
  options: { allowNull: false },
): number | undefined;
function normalizeMutationConfidence(
  params: Record<string, unknown>,
  options: { allowNull: true },
): number | null | undefined;
function normalizeMutationConfidence(
  params: Record<string, unknown>,
  options: { allowNull: boolean },
): number | null | undefined {
  if (options.allowNull && params.confidence === null) {
    return null;
  }
  return readFiniteNumberParam(params, "confidence", {
    min: 0,
    max: 1,
  });
}

// Reads stay tolerant of legacy or hand-written frontmatter. Mutations reject
// new invalid confidence before source sync or a vault write can persist it.
function normalizeMutationClaims(claims: unknown[]): WikiClaim[] {
  const normalizedClaims = normalizeWikiClaims(claims);
  for (const [index, claim] of normalizedClaims.entries()) {
    const confidence = claim.confidence;
    if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
      throw new Error(
        `claims[${index}].confidence must be a number between 0 and 1; received ${confidence}.`,
      );
    }
  }
  return normalizedClaims;
}

function normalizeMemoryWikiMutationOp(op: unknown): ApplyMemoryWikiMutation["op"] {
  if (op === "synthesis" || op === "create_synthesis") {
    return "create_synthesis";
  }
  if (op === "concept" || op === "create_concept") {
    return "create_concept";
  }
  if (op === "entity" || op === "create_entity") {
    return "create_entity";
  }
  if (op === "metadata" || op === "update_metadata") {
    return "update_metadata";
  }
  throw new Error(
    'wiki mutation op must be one of "create_synthesis", "create_concept", "create_entity", "update_metadata" (aliases: "synthesis", "concept", "entity", "metadata").',
  );
}

// Relationship reads stay tolerant like claims; mutations reject out-of-range
// confidence before it can be written into entity frontmatter.
function normalizeMutationRelationships(relationships: unknown[]): WikiRelationship[] {
  const normalized = normalizeWikiRelationships(relationships);
  for (const [index, relationship] of normalized.entries()) {
    const confidence = relationship.confidence;
    if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
      throw new Error(
        `relationships[${index}].confidence must be a number between 0 and 1; received ${confidence}.`,
      );
    }
  }
  return normalized;
}

export function normalizeMemoryWikiMutationInput(rawParams: unknown): ApplyMemoryWikiMutation {
  const params = asNonArrayRecord(rawParams) as {
    op: unknown;
    title?: string;
    body?: string;
    lookup?: string;
    sourceIds?: string[];
    claims?: WikiClaim[];
    contradictions?: string[];
    questions?: string[];
    confidence?: number | null;
    status?: string;
    entityType?: string;
    canonicalId?: string;
    aliases?: string[];
    relationships?: WikiRelationship[];
  };
  const op = normalizeMemoryWikiMutationOp(params.op);
  if (op !== "update_metadata") {
    if (!params.title?.trim()) {
      throw new Error(`wiki mutation requires title for ${op}.`);
    }
    if (!params.body?.trim()) {
      throw new Error(`wiki mutation requires body for ${op}.`);
    }
    if (!params.sourceIds || params.sourceIds.length === 0) {
      throw new Error(`wiki mutation requires at least one sourceId for ${op}.`);
    }
    const confidence = normalizeMutationConfidence(params as Record<string, unknown>, {
      allowNull: false,
    });
    const fields: CreatePageMemoryWikiMutationFields = {
      title: params.title,
      body: params.body,
      sourceIds: params.sourceIds,
      ...(Array.isArray(params.claims) ? { claims: normalizeMutationClaims(params.claims) } : {}),
      ...(params.contradictions ? { contradictions: params.contradictions } : {}),
      ...(params.questions ? { questions: params.questions } : {}),
      ...(typeof confidence === "number" ? { confidence } : {}),
      ...(params.status ? { status: params.status } : {}),
    };
    if (op !== "create_entity") {
      return { op, ...fields };
    }
    return {
      op,
      ...fields,
      ...(params.entityType?.trim() ? { entityType: params.entityType.trim() } : {}),
      ...(params.canonicalId?.trim() ? { canonicalId: params.canonicalId.trim() } : {}),
      ...(params.aliases ? { aliases: params.aliases } : {}),
      ...(Array.isArray(params.relationships)
        ? { relationships: normalizeMutationRelationships(params.relationships) }
        : {}),
    };
  }
  if (!params.lookup?.trim()) {
    throw new Error("wiki mutation requires lookup for update_metadata.");
  }
  const confidence = normalizeMutationConfidence(params as Record<string, unknown>, {
    allowNull: true,
  });
  return {
    op: "update_metadata",
    lookup: params.lookup,
    ...(params.sourceIds ? { sourceIds: params.sourceIds } : {}),
    ...(Array.isArray(params.claims) ? { claims: normalizeMutationClaims(params.claims) } : {}),
    ...(params.contradictions ? { contradictions: params.contradictions } : {}),
    ...(params.questions ? { questions: params.questions } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(params.status ? { status: params.status } : {}),
  };
}

function normalizeUniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  return uniqueStrings(normalizeStringEntries(values));
}

function ensureHumanNotesBlock(body: string): string {
  if (body.includes(HUMAN_START) && body.includes(HUMAN_END)) {
    return body;
  }
  const trimmed = body.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}## Notes\n${HUMAN_START}\n${HUMAN_END}\n`;
}

function buildManagedPageBody(params: {
  title: string;
  originalBody?: string;
  generatedBody: string;
}): string {
  const base = params.originalBody?.trim().length
    ? params.originalBody
    : `# ${params.title}\n\n## Notes\n${HUMAN_START}\n${HUMAN_END}\n`;
  const withGenerated = replaceManagedMarkdownBlock({
    original: base,
    heading: "## Summary",
    startMarker: GENERATED_START,
    endMarker: GENERATED_END,
    body: params.generatedBody,
  });
  return ensureHumanNotesBlock(withGenerated);
}

type VaultRoot = Awaited<ReturnType<typeof fsRoot>>;

function isMissingWikiPageError(error: unknown): boolean {
  return error instanceof FsSafeError && error.code === "not-found";
}

async function readExistingWikiPage(root: VaultRoot, pagePath: string): Promise<string> {
  try {
    return await root.readText(pagePath);
  } catch {
    try {
      return await root.readText(pagePath);
    } catch (retryError) {
      if (isMissingWikiPageError(retryError)) {
        return "";
      }
      throw retryError;
    }
  }
}

async function writeWikiPage(params: {
  rootDir: string;
  relativePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}): Promise<boolean> {
  const root = await fsRoot(params.rootDir);
  const rendered = withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: params.frontmatter,
      body: params.body,
    }),
  );
  const existing = await readExistingWikiPage(root, params.relativePath);
  if (existing === rendered) {
    return false;
  }
  await root.write(params.relativePath, rendered);
  return true;
}

async function resolveWritablePage(params: {
  config: ResolvedMemoryWikiConfig;
  lookup: string;
}): Promise<QueryableWikiPage | null> {
  const pages = await readQueryableWikiPages(params.config.vault.path);
  return resolveQueryableWikiPageByLookup(pages, params.lookup);
}

function buildEntityFrontmatter(mutation: CreatePageMemoryWikiMutation): Record<string, unknown> {
  if (mutation.op !== "create_entity") {
    return {};
  }
  const aliases = normalizeUniqueStrings(mutation.aliases);
  return {
    ...(mutation.entityType ? { entityType: mutation.entityType } : {}),
    ...(mutation.canonicalId ? { canonicalId: mutation.canonicalId } : {}),
    // Omitted entity lists preserve stored frontmatter; supplied lists replace
    // them, so an explicit empty array clears stale aliases/relationships.
    ...(mutation.aliases ? { aliases: aliases ?? [] } : {}),
    ...(mutation.relationships ? { relationships: mutation.relationships } : {}),
  };
}

async function applyCreatePageMutation(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: CreatePageMemoryWikiMutation;
}): Promise<{ changed: boolean; pagePath: string; pageId: string }> {
  const target = CREATE_PAGE_TARGETS[params.mutation.op];
  const slug = slugifyWikiSegment(params.mutation.title);
  const pageStem = slugifyWikiPageStem(params.mutation.title);
  const pagePath = path.join(target.dir, `${pageStem}.md`).replace(/\\/g, "/");
  const root = await fsRoot(params.config.vault.path);
  const existing = await readExistingWikiPage(root, pagePath);
  const parsed = parseWikiMarkdown(existing);
  const pageId =
    (typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.trim()) ||
    `${target.pageType}.${slug}`;
  const changed = await writeWikiPage({
    rootDir: params.config.vault.path,
    relativePath: pagePath,
    frontmatter: {
      ...parsed.frontmatter,
      pageType: target.pageType,
      id: pageId,
      title: params.mutation.title,
      ...buildEntityFrontmatter(params.mutation),
      sourceIds: normalizeSourceIds(params.mutation.sourceIds),
      ...(params.mutation.claims ? { claims: normalizeWikiClaims(params.mutation.claims) } : {}),
      ...(normalizeUniqueStrings(params.mutation.contradictions)
        ? { contradictions: normalizeUniqueStrings(params.mutation.contradictions) }
        : {}),
      ...(normalizeUniqueStrings(params.mutation.questions)
        ? { questions: normalizeUniqueStrings(params.mutation.questions) }
        : {}),
      ...(typeof params.mutation.confidence === "number"
        ? { confidence: params.mutation.confidence }
        : {}),
      status: params.mutation.status?.trim() || "active",
      updatedAt: new Date().toISOString(),
    },
    body: buildManagedPageBody({
      title: params.mutation.title,
      originalBody: parsed.body,
      generatedBody: params.mutation.body.trim(),
    }),
  });
  return { changed, pagePath, pageId };
}

function buildUpdatedFrontmatter(params: {
  original: Record<string, unknown>;
  mutation: UpdateMetadataMemoryWikiMutation;
}): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {
    ...params.original,
    updatedAt: new Date().toISOString(),
  };
  if (params.mutation.sourceIds) {
    frontmatter.sourceIds = normalizeSourceIds(params.mutation.sourceIds);
  }
  if (params.mutation.claims) {
    const claims = normalizeWikiClaims(params.mutation.claims);
    if (claims.length > 0) {
      frontmatter.claims = claims;
    } else {
      delete frontmatter.claims;
    }
  }
  if (params.mutation.contradictions) {
    const contradictions = normalizeUniqueStrings(params.mutation.contradictions) ?? [];
    if (contradictions.length > 0) {
      frontmatter.contradictions = contradictions;
    } else {
      delete frontmatter.contradictions;
    }
  }
  if (params.mutation.questions) {
    const questions = normalizeUniqueStrings(params.mutation.questions) ?? [];
    if (questions.length > 0) {
      frontmatter.questions = questions;
    } else {
      delete frontmatter.questions;
    }
  }
  if (params.mutation.confidence === null) {
    delete frontmatter.confidence;
  } else if (typeof params.mutation.confidence === "number") {
    frontmatter.confidence = params.mutation.confidence;
  }
  if (params.mutation.status?.trim()) {
    frontmatter.status = params.mutation.status.trim();
  }
  return frontmatter;
}

async function applyUpdateMetadataMutation(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: UpdateMetadataMemoryWikiMutation;
}): Promise<{ changed: boolean; pagePath: string; pageId?: string }> {
  const page = await resolveWritablePage({
    config: params.config,
    lookup: params.mutation.lookup,
  });
  if (!page) {
    throw new Error(`Wiki page not found: ${params.mutation.lookup}`);
  }
  const parsed = parseWikiMarkdown(page.raw);
  const changed = await writeWikiPage({
    rootDir: params.config.vault.path,
    relativePath: page.relativePath,
    frontmatter: buildUpdatedFrontmatter({
      original: parsed.frontmatter,
      mutation: params.mutation,
    }),
    body: parsed.body,
  });
  return {
    changed,
    pagePath: page.relativePath,
    ...(page.id ? { pageId: page.id } : {}),
  };
}

async function applyMemoryWikiMutationUnlocked(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: ApplyMemoryWikiMutation;
  signal?: AbortSignal;
}): Promise<ApplyMemoryWikiMutationResult> {
  await initializeMemoryWikiVault(
    params.config,
    params.signal ? { signal: params.signal } : undefined,
  );
  params.signal?.throwIfAborted();
  const result =
    params.mutation.op === "update_metadata"
      ? await applyUpdateMetadataMutation({
          config: params.config,
          mutation: params.mutation,
        })
      : await applyCreatePageMutation({
          config: params.config,
          mutation: params.mutation,
        });
  params.signal?.throwIfAborted();
  const compile = await compileMemoryWikiVault(
    params.config,
    params.signal ? { signal: params.signal } : undefined,
  );
  return {
    changed: result.changed,
    operation: params.mutation.op,
    pagePath: result.pagePath,
    ...(result.pageId ? { pageId: result.pageId } : {}),
    compile,
  };
}

export async function applyMemoryWikiMutation(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: ApplyMemoryWikiMutation;
  signal?: AbortSignal;
}): Promise<ApplyMemoryWikiMutationResult> {
  return await withMemoryWikiVaultMutation(params.config.vault.path, () =>
    applyMemoryWikiMutationUnlocked(params),
  );
}
