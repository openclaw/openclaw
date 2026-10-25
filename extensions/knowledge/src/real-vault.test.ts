import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  writeFile,
  rm,
  rename,
  link,
  symlink,
  access,
} from "node:fs/promises";
import path from "node:path";
import type { FeatureOperation } from "openclaw/plugin-sdk/feature-contract";
import { listDirectoryTreeStrict } from "openclaw/plugin-sdk/file-access-runtime";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { sampleVaultRoot } from "./plugin-files.js";
import { RealVault } from "./real-vault.js";
import { createKnowledgeService } from "./service.js";
import type { Manifest } from "./store-manifest.js";
import { accessFor, apiFor, useTestTempDirs, type TestStoreConfig } from "./test-support.js";

const tempDirs = useTestTempDirs();

async function fixture() {
  const base = tempDirs.make("knowledge-real-");

  const root = path.join(base, "vault");
  await mkdir(root);
  const sessionId = randomUUID();
  const manifest: Manifest = {
    format: "knowledge-vault-v2",
    vaultId: randomUUID(),
    generation: 0,
    publicationId: randomUUID(),
  };
  await writeFile(path.join(root, "vault.json"), JSON.stringify(manifest));
  const config: TestStoreConfig = {
    root,
    statePath: path.join(base, "knowledge.sqlite"),
    vaultId: manifest.vaultId,
    publicationId: manifest.publicationId,
    writesEnabled: false,
    operatorRead: true,
  };
  async function partition(relative: any, scope: any, title: any) {
    const target = path.join(root, relative);
    await mkdir(target, { recursive: true });
    await cp(sampleVaultRoot(), target, { recursive: true });
    for (const { relativePath: file } of await listDirectoryTreeStrict(target)) {
      if (file.endsWith(".md")) {
        const full = path.join(target, file),
          raw = await readFile(full, "utf8");
        await writeFile(
          full,
          raw
            .replace(
              "visibility: sample",
              `visibility: ${scope.visibility}${scope.sessionId ? `\n  sessionId: ${scope.sessionId}` : ""}`,
            )
            .replaceAll("Alex Rivera", title),
        );
      }
    }
  }
  await partition("private", { visibility: "private" }, "PRIVATE SENTINEL");
  await partition(
    `conversations/${sessionId}`,
    { visibility: "conversation", sessionId },
    "SHARED SENTINEL",
  );
  const store = new SqliteIdentityStore(config.statePath);
  const api = apiFor(base, config, { agents: ["main", "other"] });
  const owner: any = {
    source: "tool",
    api,
    tool: {
      agentId: "main",
      memoryAudience: { kind: "owner-private", agentId: "main" },
      assertInvocationCurrent() {},
      assertMemoryAudienceCurrent() {},
    },
  };
  const operator: any = {
    source: "session-action",
    api,
    action: { client: { connId: "authenticated-connection", scopes: ["operator.read"] } },
  };
  const setAudience = (audience: any) => {
    owner.tool.memoryAudience = audience;
  };
  return {
    root,
    base,
    config,
    manifest,
    sessionId,
    api,
    store,
    owner,
    operator,
    partition,
    setAudience,
    service: createKnowledgeService(api),
  };
}
const invokeAll = async (service: any, ctx: any) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(service)
        .filter(([name]) =>
          ["status", "records", "record", "ontology", "diagnostics"].includes(name),
        )
        .map(async ([name]) => [
          name,
          await service[name](name === "record" ? { id: "sample_person_alex" } : {}, ctx),
        ]),
    ),
  );

it("UI and owner-private tool read identical private records through the same service", async () => {
  const f = await fixture();
  for (const ctx of [f.owner, f.operator]) {
    const output = await invokeAll(f.service, ctx);
    for (const [name, value] of Object.entries(output)) {
      expect(
        Check(contract.operations[name as keyof typeof contract.operations].output, value),
        name,
      ).toBeTruthy();
    }
    expect(output.status.store).toBe("ready");
    expect(output.status.writesEnabled).toBe(false);
    expect(output.status.scope).toBe("private");
    expect(output.status.records).toBe(7);
    expect(JSON.stringify(output)).toMatch(/PRIVATE SENTINEL/);
    expect(JSON.stringify(output)).not.toMatch(/SHARED SENTINEL/);
  }
  expect(await f.store.lookup(`store:${f.manifest.vaultId}`)).toStrictEqual(f.manifest);
});

it("conversation audience sees only its records, counts, evidence, ontology and diagnostics", async () => {
  const f = await fixture();
  f.setAudience({
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId: f.sessionId,
  });
  const before = await invokeAll(f.service, f.owner);
  expect(JSON.stringify(before)).toMatch(/SHARED SENTINEL/);
  expect(JSON.stringify(before)).not.toMatch(/PRIVATE SENTINEL/);
  // Changes in hidden scopes cannot change any authorized result except timestamps.
  await writeFile(path.join(f.root, "private", "secret.md"), "PRIVATE INVALID SENTINEL");
  await f.partition(
    `conversations/${randomUUID()}`,
    { visibility: "conversation", sessionId: randomUUID() },
    "OTHER CONVERSATION SENTINEL",
  );
  const after = await invokeAll(f.service, f.owner);
  const stripTime = (x: any) =>
    JSON.parse(JSON.stringify(x), (k, v) =>
      ["checkedAt", "queriedAt", "scannedAt", "indexedAt"].includes(k) ? undefined : v,
    );
  expect(stripTime(after)).toStrictEqual(stripTime(before));
  expect((await f.service.record({ id: "missing-private-id" }, f.owner)).record).toBe(null);
});

it("host-resolved conversation calls are scoped; missing audience fails closed", async () => {
  const f = await fixture();
  const nonowner = {
    ...f.owner,
    tool: {
      ...f.owner.tool,
      memoryAudience: {
        kind: "conversation",
        agentId: "main",
        sessionKey: "agent:main:direct",
        sessionId: f.sessionId,
      },
    },
  };
  expect((await f.service.status({}, nonowner)).scope).toBe(`conversation:${f.sessionId}`);
  const missing = { ...f.owner, tool: { ...f.owner.tool, memoryAudience: undefined } };
  await expect(f.service.records({}, missing)).rejects.toThrow(
    /granted this session no memory audience.*"memory_audience_denied"/,
  );
});

it("missing, foreign, and revoked tool authority fails for every operation", async () => {
  const f = await fixture();
  for (const override of [
    { memoryAudience: undefined },
    { assertInvocationCurrent: undefined },
    {
      assertInvocationCurrent() {
        throw new Error("revoked");
      },
    },
    {
      assertMemoryAudienceCurrent() {
        throw new Error("audience revoked");
      },
    },
  ]) {
    for (const [name, op] of Object.entries(f.service)) {
      // One probe input for every operation, deliberately invalid for most; authority fails first.
      await expect(async () =>
        op((name === "record" ? { id: "sample_person_alex" } : {}) as never, {
          ...f.owner,
          tool: { ...f.owner.tool, ...override },
        }),
      ).rejects.toThrow();
    }
  }
});

it("another agent's audience resolves only that agent's own store", async () => {
  const f = await fixture();
  const other = {
    ...f.owner,
    tool: { ...f.owner.tool, memoryAudience: { kind: "owner-private", agentId: "other" } },
  };
  expect((await f.service.records({}, other)).total).toBe(0);
  expect(JSON.stringify(await f.service.grep({ query: "SENTINEL" }, other))).not.toMatch(
    /PRIVATE SENTINEL/,
  );
  expect((await f.service.records({}, f.owner)).total > 0).toBe(true);
});

it("operator scopes are explicit, selectors cannot create conversation authority", async () => {
  const f = await fixture();
  for (const action of [
    {},
    { client: { scopes: ["operator.read"] } },
    { client: { connId: "x", scopes: [] } },
    { ...f.operator.action, sessionKey: "agent:main:selected" },
  ]) {
    await expect(f.service.records({}, { ...f.operator, action })).rejects.toThrow();
  }
  const restricted = createKnowledgeService({ ...f.api, pluginConfig: { operatorRead: false } });
  await expect(restricted.records({}, f.operator)).rejects.toThrow();
  for (const fields of [
    { root: f.root },
    { agentId: "main" },
    { sessionId: f.sessionId },
    { scope: "agent-private" },
  ]) {
    expect(Check(contract.operations.records.input, fields)).toBe(false);
  }
});

it("operator browsing honors the role's agent ceiling and needs an administrator on a shared Gateway", async () => {
  const f = await fixture();
  const withClient = (client: Record<string, unknown>) => ({
    ...f.operator,
    action: { client: { ...f.operator.action.client, ...client } },
  });
  const allows =
    (...agents: string[]) =>
    (agent: string) =>
      agents.includes(agent);
  await expect(f.service.records({}, withClient({ allowsAgent: allows("other") }))).rejects.toThrow(
    /does not include agent "main"/,
  );
  await expect(f.service.records({}, withClient({ isSharedGateway: () => true }))).rejects.toThrow(
    /requires an administrator/,
  );
  const admin = withClient({
    allowsAgent: allows("main"),
    isSharedGateway: () => true,
    scopes: ["operator.admin"],
  });
  expect((await f.service.records({}, admin)).total > 0).toBe(true);
  expect((await f.service.records({}, withClient({ allowsAgent: allows("main") }))).total > 0).toBe(
    true,
  );
});

it("a role or roster change after admission refuses the operator read before disclosure", async () => {
  const f = await fixture();
  // Live host checks: admission sees the old policy, every later recheck the new one.
  let checks = 0;
  const changed = () => checks++ > 0;
  const withClient = (client: Record<string, unknown>) => ({
    ...f.operator,
    action: { client: { ...f.operator.action.client, ...client } },
  });
  await expect(
    f.service.records({}, withClient({ allowsAgent: () => !changed() })),
  ).rejects.toThrow();
  checks = 0;
  await expect(f.service.records({}, withClient({ isSharedGateway: changed }))).rejects.toThrow();
});

it("empty conversation scope returns an empty catalog, without creating files or reading private ontology", async () => {
  const f = await fixture(),
    sessionId = randomUUID();
  const ctx = {
    ...f.owner,
    tool: {
      ...f.owner.tool,
      memoryAudience: {
        kind: "conversation",
        agentId: "main",
        sessionKey: "agent:main:channel",
        sessionId,
      },
    },
  };
  const output = await invokeAll(f.service, ctx);
  expect(output.status.records).toBe(0);
  expect(output.record.record).toBe(null);
  expect(output.diagnostics.total).toBe(0);
  expect(output.ontology.available).toBe(true);
  expect(JSON.stringify(output)).not.toMatch(/PRIVATE SENTINEL/);
  await expect(access(path.join(f.root, "conversations", sessionId))).rejects.toThrow();
});

it("mismatched scope content is withheld, malformed files preserved", async () => {
  const f = await fixture();
  const file = path.join(f.root, "private", "people", "alex-rivera.md"),
    raw = await readFile(file, "utf8");
  const foreign = raw.replace(
    "visibility: private",
    `visibility: conversation\n  sessionId: ${f.sessionId}`,
  );
  await writeFile(file, foreign);
  const output = await invokeAll(f.service, f.owner);
  expect(output.record.record).toBe(null);
  expect(JSON.stringify(output)).not.toMatch(/PRIVATE SENTINEL/);
  expect(await readFile(file, "utf8")).toBe(foreign);
});

it("identity replacement, generation rollback/mismatch, and missing manifest never fall back to sample", async () => {
  const f = await fixture();
  await f.service.status({}, f.owner);
  for (const change of [
    { vaultId: randomUUID() },
    { publicationId: randomUUID() },
    { generation: 1 },
    { agentId: "other" },
    { format: "unknown" },
  ]) {
    await writeFile(path.join(f.root, "vault.json"), JSON.stringify({ ...f.manifest, ...change }));
    await expect(f.service.records({}, f.owner)).rejects.toThrow(/identity/);
    await expect(createKnowledgeService(f.api).records({}, f.owner)).rejects.toThrow(/identity/);
  }
  await rename(path.join(f.root, "vault.json"), path.join(f.root, "old-vault.json"));
  await expect(f.service.records({}, f.owner)).rejects.toThrow(/identity/);
});

it("the registry identity fences a replaced vault across service restarts", async () => {
  const f = await fixture();
  await f.service.status({}, f.owner);
  const replacement = { ...f.manifest, vaultId: randomUUID(), publicationId: randomUUID() };
  await writeFile(path.join(f.root, "vault.json"), JSON.stringify(replacement));
  await expect(createKnowledgeService(f.api).records({}, f.owner)).rejects.toThrow(/identity/);
  expect((await f.store.lookup(`store:${f.manifest.vaultId}`))!.vaultId).toBe(f.manifest.vaultId);
});

it("a moved store is unavailable, never replaced; reordered manifest keys are immaterial", async () => {
  const f = await fixture();
  await f.service.status({}, f.owner);
  const moved = path.join(f.base, "moved");
  await rename(f.root, moved);
  const status = await createKnowledgeService(f.api).status({}, f.owner);
  expect(status.store).toBe("unavailable");
  expect(status.vault).toBe("");
  await expect(createKnowledgeService(f.api).records({}, f.owner)).rejects.toThrow(/identity/);
  await rename(moved, f.root);
  await writeFile(
    path.join(f.root, "vault.json"),
    JSON.stringify(Object.fromEntries(Object.entries(f.manifest).toReversed())),
  );
  expect((await createKnowledgeService(f.api).status({}, f.owner)).vault).toBe(f.manifest.vaultId);
});

it("authority and identity are rechecked after asynchronous reads", async () => {
  const f = await fixture(),
    real = new RealVault(f.config, f.store);
  await expect(
    real.run(accessFor(f.owner), async (vault) => {
      const result = await vault.list({});
      f.setAudience({
        kind: "conversation",
        agentId: "main",
        sessionKey: "agent:main:group",
        sessionId: f.sessionId,
      });
      return result;
    }),
  ).rejects.toThrow(/authority/);
  f.setAudience({ kind: "owner-private", agentId: "main" });
  await expect(
    real.run(accessFor(f.owner), async (vault) => {
      const result = await vault.list({});
      await writeFile(
        path.join(f.root, "vault.json"),
        JSON.stringify({ ...f.manifest, publicationId: randomUUID() }),
      );
      return result;
    }),
  ).rejects.toThrow(/identity/);
});

it("hardlinks, file and partition symlinks cannot expose another scope", async () => {
  const f = await fixture(),
    shared = path.join(f.root, "conversations", f.sessionId);
  await link(
    path.join(f.root, "private", "people", "alex-rivera.md"),
    path.join(shared, "leak.md"),
  );
  await symlink(path.join(f.root, "private"), path.join(shared, "leak-dir"));
  await symlink(
    path.join(f.root, "private", "people", "alex-rivera.md"),
    path.join(shared, "leak-file.md"),
  );
  f.setAudience({
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId: f.sessionId,
  });
  expect(JSON.stringify(await invokeAll(f.service, f.owner))).not.toMatch(/PRIVATE SENTINEL/);
  await rename(shared, shared + "-saved");
  await symlink(path.join(f.root, "private"), shared);
  await expect(f.service.records({}, f.owner)).rejects.toThrow(/identity/);
});

it("external edits, renames, and deletion appear on next read without changing authored files", async () => {
  const f = await fixture(),
    file = path.join(f.root, "private", "people", "alex-rivera.md");
  const before = await f.service.record({ id: "sample_person_alex" }, f.owner);
  const raw = (await readFile(file, "utf8")).replace("PRIVATE SENTINEL", "Edited name");
  await writeFile(file, raw);
  await rename(file, file + "-renamed.md");
  const after = await f.service.record({ id: "sample_person_alex" }, f.owner);
  expect(after.record!.id).toBe(before.record!.id);
  expect(after.record!.hash).not.toBe(before.record!.hash);
  expect(
    (await f.service.record({ id: "sample_person_alex", view: "raw" }, f.owner)).record!.raw,
  ).toBe(raw);
  await rm(file + "-renamed.md");
  expect((await f.service.record({ id: "sample_person_alex" }, f.owner)).record).toBe(null);
});

it("identity bindings persist across connections and competing registrations never replace them", async () => {
  const f = await fixture(),
    rival = { ...f.manifest, publicationId: randomUUID() };
  const key = `store:${randomUUID()}`;
  const results = await Promise.all([
    f.store.registerIfAbsent(key, f.manifest),
    new SqliteIdentityStore(f.config.statePath).registerIfAbsent(key, rival),
  ]);
  expect(results).toStrictEqual([true, false]);
  expect(await new SqliteIdentityStore(f.config.statePath).lookup(key)).toStrictEqual(f.manifest);
});

it("unrelated/corrupt operational databases and database links fail closed without replacement", async () => {
  const f = await fixture();
  await writeFile(f.config.statePath, "unrelated content");
  await expect(f.service.status({}, f.owner)).rejects.toThrow();
  expect(await readFile(f.config.statePath, "utf8")).toBe("unrelated content");
  await rename(f.config.statePath, f.config.statePath + ".saved");
  await symlink(f.config.statePath + ".saved", f.config.statePath);
  await expect(f.service.status({}, f.owner)).rejects.toThrow();
  expect(await readFile(f.config.statePath + ".saved", "utf8")).toBe("unrelated content");
});

it("build metadata retains the real-vault configuration contract", async () => {
  const { default: entry } = await import("./index.js");
  const { getToolPluginMetadata } = await import("openclaw/plugin-sdk/tool-plugin");
  // JSON-schema metadata is untyped; the built config schema's properties are object schemas.
  const properties = entry.configSchema.jsonSchema!.properties as Record<
    string,
    Record<string, unknown>
  >;
  expect(properties.stores!.patternProperties).toBeTruthy();
  expect(properties.vault).toBe(undefined);
  expect(getToolPluginMetadata(entry)!.configSchema).toStrictEqual(entry.configSchema.jsonSchema);
  expect(getToolPluginMetadata(entry)!.tools.length).toBe(
    Object.values<FeatureOperation>(contract.operations).filter((operation) => operation.tool)
      .length,
  );
});

it("all opt-in inspection views retain conversation scope and authority", async () => {
  const f = await fixture();
  f.setAudience({
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId: f.sessionId,
  });
  for (const input of [
    { id: "sample_person_alex", view: "raw" },
    { id: "sample_person_alex", includeMetadata: true, includeReferences: true },
  ] as const) {
    const result = await f.service.record(input, f.owner);
    expect(Check(contract.operations.record.output, result)).toBeTruthy();
    expect(JSON.stringify(result)).toMatch(/SHARED SENTINEL/);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE SENTINEL/);
  }
  await writeFile(path.join(f.root, "private", "ontology.yaml"), "PRIVATE BROKEN ONTOLOGY");
  for (const input of [
    { view: "definitions", includeRecords: true },
    { view: "sources" },
    { view: "diagnostics" },
  ] as const) {
    const result = await f.service.ontology(input, f.owner);
    expect(Check(contract.operations.ontology.output, result)).toBeTruthy();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  }
  await expect(
    f.service.ontology({ view: "sources", sourcePath: "../private/ontology.yaml" }, f.owner),
  ).rejects.toThrow(/unavailable/);
});
