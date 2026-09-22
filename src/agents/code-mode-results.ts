import { randomUUID } from "node:crypto";
import {
  stringifyCodeModeJsonSafe,
  type CodeModeJsonSource,
  type CodeModeValueRetention,
} from "./code-mode-json.js";
import { createCodeModeResultReference } from "./code-mode-result-preview.js";
import type { CodeModeConfig } from "./code-mode-worker-types.js";
import { ToolInputError } from "./tool-input-error.js";
import type { ToolSearchCatalogRef, ToolSearchToolContext } from "./tool-search-types.js";

type SavedResult = { json: string; bytes: number; networkContent: boolean };
type ResultsStore = {
  scope: string;
  maxBytes: number;
  bytes: number;
  entries: Map<string, SavedResult>;
  close: () => void;
};

// The existing admitted catalog owns these data, independently of cell VMs.
const stores = new WeakMap<ToolSearchCatalogRef, ResultsStore>();
const MAX_RESULTS = 64;

export function disposeCodeModeResults(owner: ToolSearchCatalogRef): void {
  stores.get(owner)?.close();
}

export type CodeModeResultsAccess = ReturnType<typeof createCodeModeResultsAccess>;

/** Capture cell authority now; never let an old cell adopt a replacement catalog. */
export function createCodeModeResultsAccess(
  ctx: ToolSearchToolContext,
  config: Pick<CodeModeConfig, "memoryLimitBytes" | "maxSnapshotBytes">,
) {
  const owner = ctx.catalogRef;
  const catalog = owner?.current;
  const entries = catalog?.entries;
  const scope = JSON.stringify([
    ctx.agentId,
    ctx.runId,
    ctx.sessionId,
    ctx.sessionKey,
    catalog?.counterScope,
  ]);
  const maxBytes = Math.min(config.memoryLimitBytes, config.maxSnapshotBytes);
  const currentStore = (create = false): ResultsStore => {
    ctx.abortSignal?.throwIfAborted();
    if (
      !owner?.current ||
      owner.current.counterScope !== catalog?.counterScope ||
      owner.current.entries !== entries
    ) {
      throw new ToolInputError(
        "Code Mode results are unavailable after the run catalog changed or closed.",
      );
    }
    const currentScope = JSON.stringify([
      ctx.agentId,
      ctx.runId,
      ctx.sessionId,
      ctx.sessionKey,
      owner.current.counterScope,
    ]);
    let store = stores.get(owner);
    if (currentScope !== scope || (store && store.scope !== scope)) {
      throw new ToolInputError("Code Mode results belong to a different run or session.");
    }
    if (!store && create) {
      const signal = ctx.abortSignal;
      const created: ResultsStore = {
        scope,
        maxBytes,
        bytes: 0,
        entries: new Map(),
        close: () => {
          created.entries.clear();
          created.bytes = 0;
          signal?.removeEventListener("abort", created.close);
          if (stores.get(owner) === created) {
            stores.delete(owner);
          }
        },
      };
      stores.set(owner, created);
      signal?.addEventListener("abort", created.close, { once: true });
      store = created;
    }
    if (!store) {
      throw new ToolInputError(
        "Code Mode result is unavailable or expired; fetch fresh data if needed.",
      );
    }
    return store;
  };
  const find = (id: unknown) => {
    if (typeof id !== "string" || !id) {
      throw new ToolInputError("results reference id must be a non-empty string.");
    }
    const store = currentStore();
    const entry = store.entries.get(id);
    if (!entry) {
      throw new ToolInputError(
        "Code Mode result is unavailable or expired; fetch fresh data if needed.",
      );
    }
    return { store, entry, id };
  };
  const retainJson = (json: string, networkContent: boolean): CodeModeValueRetention => {
    const bytes = Buffer.byteLength(json, "utf8");
    const store = currentStore(true);
    const allowance = Math.min(store.maxBytes, maxBytes);
    if (bytes > allowance) {
      return { reason: "Not retained: result exceeds the data allowance. Return less data." };
    }
    if (store.entries.size >= MAX_RESULTS || bytes > allowance - store.bytes) {
      return {
        reason:
          "Not retained: result-store capacity exceeded. Delete references or return less data.",
      };
    }
    // Admission precedes a detached parse. The worker's normalized JSON string
    // moves into the existing store without another full serialization.
    const id = `result_${randomUUID()}`;
    const reference = createCodeModeResultReference(id, json, JSON.parse(json) as unknown);
    store.entries.set(id, { json, bytes, networkContent });
    store.bytes += bytes;
    return {
      reference,
      release: () => {
        if (store.entries.delete(id)) {
          store.bytes -= bytes;
        }
      },
    };
  };
  return {
    save(value: unknown, networkContent: boolean) {
      const retained = retainJson(stringifyCodeModeJsonSafe(value), networkContent);
      if ("reason" in retained) {
        throw new ToolInputError(
          "Code Mode results capacity exceeded; delete saved references or save a smaller value. Existing references are unchanged.",
        );
      }
      return retained.reference;
    },
    retain(source: CodeModeJsonSource, networkContent: boolean): CodeModeValueRetention {
      if (source.kind !== "complete") {
        return { reason: "Not retained: result exceeds the data allowance. Return less data." };
      }
      try {
        return retainJson(source.json, networkContent);
      } catch (error) {
        if (error instanceof ToolInputError) {
          return {
            reason: "Not retained: run catalog is unavailable or changed. Return less data.",
          };
        }
        throw error;
      }
    },
    load(id: unknown) {
      const { entry } = find(id);
      return { value: JSON.parse(entry.json) as unknown, networkContent: entry.networkContent };
    },
    delete(id: unknown) {
      const { store, entry, id: key } = find(id);
      store.entries.delete(key);
      store.bytes -= entry.bytes;
      return true;
    },
  };
}
