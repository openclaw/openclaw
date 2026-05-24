import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "../runtime-api.js";

type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | {
      [key: string]: JsonLike;
    };

type KeyedStoreEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
  expiresAt?: number;
};

type KeyedStore<T> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<KeyedStoreEntry<T>[]>;
};

export type LobsterWorkflowRecord = {
  workflowId: string;
  revision: number;
  name?: string;
  slug?: string;
  cwd?: string;
  metadata?: JsonLike;
  workflowPath: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  updatedAt: string;
};

export type LobsterWorkflowRecordWithDocument = LobsterWorkflowRecord & {
  workflowYaml?: string;
};

export type LobsterWorkflowStore = {
  publish: (params: {
    workflowYaml: string;
    workflowId?: string;
    slug?: string;
    name?: string;
    cwd?: string;
    metadata?: JsonLike;
    overwrite?: boolean;
  }) => Promise<LobsterWorkflowRecord>;
  list: (params?: {
    limit?: number;
    cursor?: string;
    query?: string;
  }) => Promise<{ workflows: LobsterWorkflowRecord[]; nextCursor?: string }>;
  get: (
    workflowId: string,
    opts?: { includeDocument?: boolean },
  ) => Promise<LobsterWorkflowRecordWithDocument | undefined>;
  delete: (
    workflowId: string,
    opts?: { expectedRevision?: number },
  ) => Promise<{ deleted: boolean; workflowId: string }>;
  materialize: (
    workflowId: string,
    opts?: { expectedRevision?: number },
  ) => Promise<LobsterWorkflowRecord>;
};

export type LobsterWorkflowStoreOptions = {
  stateDir: string;
  store: KeyedStore<LobsterWorkflowRecord>;
  now?: () => Date;
};

const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 128);
}

function normalizeWorkflowId(params: {
  workflowId?: string;
  slug?: string;
  name?: string;
  workflowYaml: string;
}): { workflowId: string; slug?: string } {
  const explicitId = normalizeTrimmedString(params.workflowId);
  const explicitSlug = normalizeTrimmedString(params.slug);
  const name = normalizeTrimmedString(params.name);
  const slug =
    (explicitSlug ? slugify(explicitSlug) : undefined) ??
    (name ? slugify(name) : undefined) ??
    `workflow-${sha256(params.workflowYaml).slice(0, 12)}`;
  const workflowId = explicitId ? slugify(explicitId) : slug;

  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new Error("workflowId must contain a safe lowercase id");
  }
  if (explicitSlug && !WORKFLOW_ID_PATTERN.test(slug)) {
    throw new Error("slug must contain a safe lowercase id");
  }
  return {
    workflowId,
    ...(slug ? { slug } : {}),
  };
}

function normalizeMetadata(value: unknown): JsonLike {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("metadata must be JSON-serializable");
  }
  return JSON.parse(serialized) as JsonLike;
}

function workflowDir(stateDir: string, workflowId: string): string {
  return path.join(stateDir, "lobster", "workflows", workflowId);
}

function workflowPath(stateDir: string, workflowId: string, revision: number): string {
  return path.join(workflowDir(stateDir, workflowId), `rev-${revision}.lobster`);
}

async function assertWorkflowFileAvailable(record: LobsterWorkflowRecord): Promise<void> {
  const fileStat = await stat(record.workflowPath);
  if (!fileStat.isFile()) {
    throw new Error(`Published workflow is not a file: ${record.workflowId}`);
  }
}

export function createLobsterWorkflowStore(
  options: LobsterWorkflowStoreOptions,
): LobsterWorkflowStore {
  const now = options.now ?? (() => new Date());
  return {
    async publish(params) {
      const workflowYaml = normalizeTrimmedString(params.workflowYaml);
      if (!workflowYaml) {
        throw new Error("workflowYaml required");
      }
      const id = normalizeWorkflowId({
        workflowYaml,
        workflowId: params.workflowId,
        slug: params.slug,
        name: params.name,
      });
      const existing = await options.store.lookup(id.workflowId);
      if (existing && params.overwrite === false) {
        throw new Error(`workflow already exists: ${id.workflowId}`);
      }

      const revision = existing ? existing.revision + 1 : 1;
      const timestamp = now().toISOString();
      const filePath = workflowPath(options.stateDir, id.workflowId, revision);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, workflowYaml, "utf8");

      const record: LobsterWorkflowRecord = {
        workflowId: id.workflowId,
        revision,
        ...(params.name ? { name: params.name } : {}),
        ...(id.slug ? { slug: id.slug } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.metadata !== undefined ? { metadata: normalizeMetadata(params.metadata) } : {}),
        workflowPath: filePath,
        sha256: sha256(workflowYaml),
        bytes: byteLength(workflowYaml),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await options.store.register(record.workflowId, record);
      return record;
    },

    async list(params = {}) {
      const limit = Math.max(1, Math.min(250, params.limit ?? 50));
      const cursor = normalizeTrimmedString(params.cursor);
      const query = normalizeTrimmedString(params.query)?.toLowerCase();
      const entries = await options.store.entries();
      const sorted = entries
        .map((entry) => entry.value)
        .filter((record) => {
          if (!query) {
            return true;
          }
          return (
            record.workflowId.toLowerCase().includes(query) ||
            record.name?.toLowerCase().includes(query) ||
            record.slug?.toLowerCase().includes(query)
          );
        })
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.workflowId.localeCompare(b.workflowId),
        );
      const startIndex = cursor
        ? Math.max(0, sorted.findIndex((record) => record.workflowId === cursor) + 1)
        : 0;
      const workflows = sorted.slice(startIndex, startIndex + limit);
      const next = sorted[startIndex + limit];
      return {
        workflows,
        ...(next ? { nextCursor: next.workflowId } : {}),
      };
    },

    async get(workflowId, opts = {}) {
      const record = await options.store.lookup(workflowId);
      if (!record) {
        return undefined;
      }
      if (!opts.includeDocument) {
        return record;
      }
      return {
        ...record,
        workflowYaml: await readFile(record.workflowPath, "utf8"),
      };
    },

    async delete(workflowId, opts = {}) {
      const record = await options.store.lookup(workflowId);
      if (!record) {
        return { deleted: false, workflowId };
      }
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== record.revision) {
        throw new Error(
          `workflow revision mismatch: expected ${opts.expectedRevision}, found ${record.revision}`,
        );
      }
      await options.store.delete(workflowId);
      await rm(workflowDir(options.stateDir, workflowId), { recursive: true, force: true });
      return { deleted: true, workflowId };
    },

    async materialize(workflowId, opts = {}) {
      const record = await options.store.lookup(workflowId);
      if (!record) {
        throw new Error(`unknown workflowId: ${workflowId}`);
      }
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== record.revision) {
        const historicalPath = workflowPath(options.stateDir, workflowId, opts.expectedRevision);
        try {
          const workflowYaml = await readFile(historicalPath, "utf8");
          return {
            ...record,
            revision: opts.expectedRevision,
            workflowPath: historicalPath,
            sha256: sha256(workflowYaml),
            bytes: byteLength(workflowYaml),
          };
        } catch {
          throw new Error(
            `workflow revision mismatch: expected ${opts.expectedRevision}, found ${record.revision}`,
          );
        }
      }
      await assertWorkflowFileAvailable(record);
      return record;
    },
  };
}

export function createLobsterWorkflowStoreFromApi(api: OpenClawPluginApi): LobsterWorkflowStore {
  return createLobsterWorkflowStore({
    stateDir: api.runtime.state.resolveStateDir(),
    store: api.runtime.state.openKeyedStore<LobsterWorkflowRecord>({
      namespace: "lobster.workflows",
      maxEntries: 500,
    }),
  });
}
