import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sameSessionTranscriptTargetBinding } from "../config/sessions/transcript-target-binding.js";
import { stringifyCodeModeJsonSafe } from "./code-mode-json.js";
import type { PendingBridgeRequest } from "./code-mode-worker-types.js";
import type { SessionEntry, SessionManager } from "./sessions/session-manager.js";
import type { ToolSearchCatalogRef, ToolSearchToolContext } from "./tool-search-types.js";

const CUSTOM_TYPE = "openclaw.code-mode-store";
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
type StoredValue = { json: string; bytes: number; networkContent: boolean };
type Projection = Map<string, StoredValue>;
type WithOwnedTranscriptWrite = <T>(operation: () => T | Promise<T>) => Promise<T>;
type SessionStore = {
  manager: SessionManager;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
  counterScope?: string;
  scope?: string;
  controller: AbortController;
  projection?: Promise<Projection>;
  commitTail: Promise<void>;
};

// The catalog owns the projection, while the transcript alone owns durable state.
const stores = new WeakMap<ToolSearchCatalogRef, SessionStore>();

export function disposeCodeModeSessionStore(owner: ToolSearchCatalogRef): void {
  const store = stores.get(owner);
  stores.delete(owner);
  store?.controller.abort();
  // Restriction/replacement retires accesses, but the session binding belongs to
  // the enclosing attempt. Actual teardown clears current before disposal.
  if (store && owner.current) {
    stores.set(owner, {
      manager: store.manager,
      withOwnedTranscriptWrite: store.withOwnedTranscriptWrite,
      scope: store.scope,
      counterScope: owner.current.counterScope,
      controller: new AbortController(),
      commitTail: store.commitTail,
    });
  }
}

export function bindCodeModeSessionStore(
  owner: ToolSearchCatalogRef,
  manager: SessionManager,
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite = async (operation) => operation(),
): void {
  stores.get(owner)?.controller.abort();
  stores.set(owner, {
    manager,
    withOwnedTranscriptWrite,
    counterScope: owner.current?.counterScope,
    controller: new AbortController(),
    commitTail: Promise.resolve(),
  });
}

function readKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 256) {
    throw new TypeError(
      "Code Mode store key must be a non-empty string of at most 256 characters.",
    );
  }
  return key;
}

function encode(value: unknown, networkContent: boolean): StoredValue {
  const json = stringifyCodeModeJsonSafe(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_VALUE_BYTES) {
    throw new RangeError("Code Mode store value exceeds 256 KiB of serialized JSON.");
  }
  return { json, bytes, networkContent };
}

function applyWrites(projection: Projection, writes: ReadonlyMap<string, StoredValue | null>) {
  const next = new Map(projection);
  for (const [key, value] of writes) {
    if (value === null) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  let bytes = 0;
  for (const value of next.values()) {
    bytes += value.bytes;
  }
  if (bytes > MAX_TOTAL_BYTES) {
    throw new RangeError(
      "Code Mode store exceeds 1 MiB of serialized JSON; delete keys or store less data.",
    );
  }
  return next;
}

function replay(entries: readonly SessionEntry[]): Projection {
  let projection: Projection = new Map();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) {
      continue;
    }
    const data = entry.data;
    if (
      !isRecord(data) ||
      !isRecord(data.set) ||
      !Array.isArray(data.delete) ||
      !isRecord(data.networkContent)
    ) {
      throw new Error(
        "Code Mode session store contains an invalid transcript entry; repair the session before using store/load.",
      );
    }
    const writes = new Map<string, StoredValue | null>();
    for (const [key, value] of Object.entries(data.set)) {
      const networkContent = data.networkContent[key];
      if (typeof networkContent !== "boolean") {
        throw new Error(
          "Code Mode session store contains invalid content provenance; repair the session before using store/load.",
        );
      }
      writes.set(readKey(key), encode(value, networkContent));
    }
    for (const key of data.delete) {
      writes.set(readKey(key), null);
    }
    projection = applyWrites(projection, writes);
  }
  return projection;
}

export type CodeModeSessionStoreAccess = ReturnType<typeof createCodeModeSessionStoreAccess>;

/** store/load reuse the results bridge methods with a "session" selector (see the controller shim). */
export function isCodeModeSessionStoreRequest(request: PendingBridgeRequest): boolean {
  return (
    (request.method === "resultSave" ||
      request.method === "resultLoad" ||
      request.method === "resultDelete") &&
    request.args[1] === "session"
  );
}

/** Commits a completed cell's writes; returns a warning when persistence is unconfirmed. */
export async function commitCodeModeSessionStore(
  access: CodeModeSessionStoreAccess | undefined,
): Promise<string | undefined> {
  try {
    await access?.commit();
    return undefined;
  } catch {
    return "Code Mode session store persistence could not be confirmed. The cell completed; verify the session transcript before relying on these values in a later cell or reply.";
  }
}

/** Each cell retains a private write buffer and the exact admitted run projection. */
export function createCodeModeSessionStoreAccess(ctx: ToolSearchToolContext, signal: AbortSignal) {
  const owner = ctx.catalogRef;
  const store = owner ? stores.get(owner) : undefined;
  const scope = JSON.stringify([ctx.agentId, ctx.runId, ctx.sessionId, ctx.sessionKey]);
  const sessionId = store?.manager.getSessionId();
  const target = store?.manager.getSessionTarget();
  const writes = new Map<string, StoredValue | null>();
  let closed = false;
  let committing = false;
  const assertOwner = (): SessionStore => {
    ctx.abortSignal?.throwIfAborted();
    if (
      !owner?.current ||
      !store ||
      stores.get(owner) !== store ||
      store.controller.signal.aborted ||
      owner.current.counterScope !== store.counterScope
    ) {
      throw new Error(
        "Code Mode store/load requires an active session-bound run; start a new interactive reply with a session.",
      );
    }
    store.scope ??= scope;
    if (
      store.scope !== scope ||
      store.manager.getSessionId() !== sessionId ||
      !sameSessionTranscriptTargetBinding(target, store.manager.getSessionTarget())
    ) {
      throw new Error(
        "Code Mode store/load belongs to a different run or session; start a new interactive reply.",
      );
    }
    return store;
  };
  const assertCell = () => {
    signal.throwIfAborted();
    if (closed) {
      throw new Error("Code Mode store/load is unavailable after the cell closed.");
    }
    return assertOwner();
  };
  const projection = async () => {
    const active = assertCell();
    active.projection ??= (async () => {
      const manager = active.manager;
      if (target) {
        const { SessionManager } = await import("./sessions/session-manager.js");
        assertOwner();
        const replaySignal = ctx.abortSignal
          ? AbortSignal.any([ctx.abortSignal, active.controller.signal])
          : active.controller.signal;
        return active.withOwnedTranscriptWrite(async () => {
          assertOwner();
          const leaf = manager.getLeafId();
          const full = await SessionManager.openAsync(
            target,
            manager.getCwd(),
            undefined,
            replaySignal,
          );
          assertOwner();
          if (manager.getLeafId() !== leaf || (leaf !== null && !full.getEntry(leaf))) {
            throw new Error(
              "Code Mode session store could not match the active transcript branch; retry in a new reply.",
            );
          }
          const entries = leaf === null ? [] : full.getBranch(leaf);
          if (leaf !== null && entries.at(-1)?.id !== leaf) {
            throw new Error(
              "Code Mode session store could not replay the active transcript branch; retry in a new reply.",
            );
          }
          return replay(entries);
        });
      }
      return replay(manager.getBranch());
    })();
    const current = await active.projection;
    assertCell();
    return current;
  };
  const write = async (name: string, value: StoredValue | null) => {
    const current = await projection();
    if (committing) {
      throw new Error("Code Mode store/load is unavailable while the cell is committing.");
    }
    const proposed = new Map(writes).set(name, value);
    applyWrites(current, proposed);
    writes.set(name, value);
  };
  return {
    async save(key: unknown, value: unknown, networkContent: boolean): Promise<void> {
      await write(readKey(key), value === undefined ? null : encode(value, networkContent));
    },
    async delete(key: unknown): Promise<void> {
      await write(readKey(key), null);
    },
    async load(key: unknown): Promise<{ value?: unknown; networkContent: boolean }> {
      const name = readKey(key);
      const current = await projection();
      const value = writes.has(name) ? writes.get(name) : current.get(name);
      return value
        ? { value: JSON.parse(value.json) as unknown, networkContent: value.networkContent }
        : { networkContent: false };
    },
    async commit(): Promise<void> {
      if (writes.size === 0) {
        return;
      }
      const active = assertCell();
      if (committing) {
        throw new Error("Code Mode session store is already committing this cell.");
      }
      committing = true;
      const pending = active.commitTail.then(async () => {
        const current = await projection();
        const next = applyWrites(current, writes);
        const set = Object.fromEntries(
          [...writes].flatMap(([key, value]) =>
            value ? [[key, JSON.parse(value.json) as unknown]] : [],
          ),
        );
        const deleted = [...writes].filter(([, value]) => value === null).map(([key]) => key);
        const networkContent = Object.fromEntries(
          [...writes].flatMap(([key, value]) => (value ? [[key, value.networkContent]] : [])),
        );
        const { withSessionManagerWriteAssertion } =
          await import("./sessions/session-manager-write-admission.js");
        assertCell();
        await active.withOwnedTranscriptWrite(() =>
          withSessionManagerWriteAssertion(active.manager, assertCell, () =>
            active.manager.appendCustomEntryAsync(CUSTOM_TYPE, {
              set,
              delete: deleted,
              networkContent,
            }),
          ),
        );
        assertCell();
        active.projection = Promise.resolve(next);
        writes.clear();
      });
      active.commitTail = pending.catch(() => {});
      try {
        await pending;
      } finally {
        closed = true;
        writes.clear();
      }
    },
    close(): void {
      closed = true;
      writes.clear();
    },
  };
}
