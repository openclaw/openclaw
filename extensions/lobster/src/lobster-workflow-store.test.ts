import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLobsterWorkflowStore,
  type LobsterWorkflowRecord,
} from "./lobster-workflow-store.js";

function createMemoryStore<T>() {
  const entries = new Map<string, { value: T; createdAt: number }>();
  return {
    async register(key: string, value: T) {
      entries.set(key, { value, createdAt: Date.now() });
    },
    async lookup(key: string) {
      return entries.get(key)?.value;
    },
    async delete(key: string) {
      return entries.delete(key);
    },
    async entries() {
      return Array.from(entries.entries(), ([key, entry]) => ({
        key,
        value: entry.value,
        createdAt: entry.createdAt,
      }));
    },
  };
}

async function createStore() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "lobster-workflow-store-"));
  return createLobsterWorkflowStore({
    stateDir,
    store: createMemoryStore<LobsterWorkflowRecord>(),
    now: () => new Date("2026-05-22T00:00:00.000Z"),
  });
}

describe("lobster workflow store", () => {
  it("publishes workflow documents as durable file-backed records", async () => {
    const store = await createStore();
    const workflowYaml = "name: Demo\nsteps:\n  - id: hello\n    run: echo hi\n";

    const record = await store.publish({
      workflowYaml,
      workflowId: "Demo Flow",
      name: "Demo Flow",
      cwd: "workflows",
      metadata: { source: "builder" },
    });

    expect(record).toMatchObject({
      workflowId: "demo-flow",
      revision: 1,
      name: "Demo Flow",
      cwd: "workflows",
      metadata: { source: "builder" },
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    });
    expect(record.sha256).toHaveLength(64);
    await expect(readFile(record.workflowPath, "utf8")).resolves.toBe(workflowYaml.trim());
  });

  it("increments revisions and materializes pinned historical revisions", async () => {
    const store = await createStore();

    await store.publish({ workflowYaml: "name: Demo\nsteps: []\n", workflowId: "demo" });
    const updated = await store.publish({
      workflowYaml: "name: Demo 2\nsteps: []\n",
      workflowId: "demo",
    });

    expect(updated.revision).toBe(2);
    await expect(store.materialize("demo", { expectedRevision: 1 })).resolves.toMatchObject({
      workflowId: "demo",
      revision: 1,
    });
    await expect(store.materialize("demo", { expectedRevision: 2 })).resolves.toMatchObject({
      workflowId: "demo",
      revision: 2,
    });
    await expect(store.materialize("demo", { expectedRevision: 3 })).rejects.toThrow(
      /revision mismatch/,
    );
  });

  it("lists, fetches documents, and deletes published workflows", async () => {
    const store = await createStore();

    await store.publish({ workflowYaml: "name: A\nsteps: []\n", workflowId: "alpha" });
    await store.publish({ workflowYaml: "name: B\nsteps: []\n", workflowId: "beta" });

    await expect(store.list({ query: "alp" })).resolves.toMatchObject({
      workflows: [expect.objectContaining({ workflowId: "alpha" })],
    });
    await expect(store.get("beta", { includeDocument: true })).resolves.toMatchObject({
      workflowId: "beta",
      workflowYaml: "name: B\nsteps: []",
    });
    await expect(store.delete("beta")).resolves.toEqual({ deleted: true, workflowId: "beta" });
    await expect(store.get("beta")).resolves.toBeUndefined();
  });
});
