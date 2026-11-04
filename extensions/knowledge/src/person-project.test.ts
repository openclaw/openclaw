import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import type { MemoryProviderRuntime } from "./memory-provider-types.js";
import { personGrantKey, type PersonGrantChangeInput } from "./person-grants-contract.js";
import { RegistryClient } from "./registry-client.js";
import type { RegistryResponse } from "./registry-host.js";
import { createKnowledgeService } from "./service.js";
import type { RegistrySnapshot } from "./store-registry.js";
import {
  afterTest,
  hostApi,
  operatorContext,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

const dirs = useTestTempDirs();
type Service = ReturnType<typeof createKnowledgeService>;
type HookContext = Parameters<typeof import("./memory-index-hook.js").readMemoryIndex>[1];
type PromptHook = (
  event: { prompt: string; messages: unknown[] },
  context: HookContext,
) => Promise<{ appendSystemContext?: string } | undefined>;

function fixture() {
  const services: { stop(): Promise<void> }[] = [];
  let runtime: MemoryProviderRuntime | undefined;
  let hook: PromptHook | undefined;
  const { api, host } = hostApi(dirs.make("person-project-"), {
    agents: ["main", "research"],
    stores: { work: { agents: ["main", "research"] } },
    extra: {
      registerService: (service: { stop(): Promise<void> }) => services.push(service),
      registerMemoryCapability: (capability: { providerRuntime?: MemoryProviderRuntime }) => {
        runtime = capability.providerRuntime;
      },
      on: (name: string, callback: PromptHook) => {
        if (name === "before_prompt_build") {
          hook = callback;
        }
      },
    },
  });
  afterTest(() => Promise.all(services.map((service) => service.stop())));
  let service = createKnowledgeService(api);
  const admin = operatorContext(api, ["operator.admin"]);
  const person = (agent = "main", profileId = "person-p") =>
    toolContext(api, agent, {
      kind: "owner-private",
      agentId: agent,
      requesterProfileId: profileId,
    });
  const save = (context: Parameters<Service["save_page"]>[1], title: string) =>
    service.save_page(
      {
        requestId: randomUUID(),
        title,
        type: "note",
        body: title + " body.",
      },
      context,
    );
  const grant = async (
    agent: string,
    space: string,
    access: PersonGrantChangeInput["access"] = "read-write",
    profileId = "person-p",
  ) => {
    const snapshot = await service.person_grants({}, admin);
    const result = await service.person_grant(
      { expectedRevision: snapshot.revision, profileId, agent, space, access },
      admin,
    );
    expect(result.outcome).toBe("applied");
  };
  const open = async (agent = "main", profileId = "person-p") => {
    const context = {
      authority: {
        kind: "session" as const,
        sessionKey: "agent:" + agent + ":person",
        sandboxed: false,
        audience: person(agent, profileId).tool.memoryAudience,
      },
      assertCurrent() {},
    };
    const opened = await runtime!.open({ cfg: {}, agentId: agent, context });
    expect(opened.provider).toBeTruthy();
    return opened.provider!;
  };
  const index = (agent: string, cutoff = Date.now()) =>
    hook!(
      { prompt: "hello", messages: [{ timestamp: cutoff }] },
      {
        agentId: agent,
        sessionKey: "agent:" + agent + ":person",
        sessionId: "stable-session",
        memoryAudience: person(agent).tool.memoryAudience,
        assertMemoryAudienceCurrent() {},
      },
    );
  return {
    api,
    host,
    admin,
    person,
    save,
    grant,
    open,
    index,
    get service() {
      return service;
    },
    async restart() {
      await Promise.all(services.splice(0).map((entry) => entry.stop()));
      service = createKnowledgeService(api);
    },
  };
}

it("a verified requester without a person grant cannot fall back to agent-private records", async () => {
  const f = fixture();
  await f.save(toolContext(f.api), "Legacy owner secret");
  await expect(f.service.records({}, f.person("research"))).rejects.toThrow(
    /explicit person.*grant.*Ask a Gateway administrator.*person_grants and person_grant/,
  );
});

it("shares one person's project through native publication while withholding personal metadata, evidence and index", async () => {
  const f = fixture();
  await f.grant("main", "personal");
  const a = f.person(),
    b = f.person("research");
  const upload = await f.service.attach(
    {
      requestId: randomUUID(),
      filename: "personal.txt",
      attribution: "Synthetic fixture",
      offset: 0,
      data: Buffer.from("Personal original secret\n").toString("base64"),
      final: true,
    },
    a,
  );
  const personal = await f.service.save_page(
    {
      requestId: randomUUID(),
      title: "Personal sentinel",
      type: "note",
      body: "Personal body",
      attachments: [upload.evidence!],
    },
    a,
  );
  await f.service.recall(
    {
      requestId: randomUUID(),
      id: personal.id,
      expectedRevision: personal.revision,
      expectedHash: personal.hash,
      set: {
        summary: "Personal recall sentinel",
        triggers: ["personal"],
        importance: 1,
        projects: [],
      },
    },
    a,
  );
  const personalProvider = await f.open();
  expect((await personalProvider.candidates!({ kind: "trigger" })).hits).toHaveLength(1);
  const personalRef = (await personalProvider.search({ query: "Personal" })).hits[0]!.reference;
  await f.grant("main", "orchid");
  await f.grant("research", "orchid", "read");
  const projectUpload = await f.service.attach(
    {
      requestId: randomUUID(),
      filename: "project.txt",
      attribution: "Synthetic project fixture",
      offset: 0,
      data: Buffer.from("Shared original evidence\n").toString("base64"),
      final: true,
    },
    a,
  );
  const project = await f.service.save_page(
    {
      requestId: randomUUID(),
      title: "Orchid decision",
      type: "note",
      body: "Orchid decision body.",
      attachments: [projectUpload.evidence!],
    },
    a,
  );
  expect(personal.git?.state).toBe("committed");
  expect(project.git?.state).toBe("committed");
  const cutoff = Date.now();
  await f.grant("main", "personal");
  expect(JSON.stringify(await f.index("main", cutoff))).toContain("Personal sentinel");
  await f.grant("main", "orchid");
  const provider = await f.open("research");
  const result = await provider.search({ query: "Orchid" });
  expect(result.hits).toHaveLength(1);
  const exact = await provider.get({ reference: result.hits[0]!.reference, lines: 200 });
  expect(exact.status).toBe("ok");
  expect(JSON.stringify(exact)).toContain("Orchid decision body.");
  const fromB = (await f.service.record({ id: project.id }, b)).record!;
  expect([fromB.id, fromB.revision, fromB.hash]).toEqual([
    project.id,
    project.revision,
    project.hash,
  ]);
  expect((await f.service.records({}, b)).total).toBe(1);
  expect(
    (
      await f.service.evidence_read(
        {
          id: project.id,
          path: projectUpload.evidence!.path,
          sha256: projectUpload.evidence!.sha256,
        },
        b,
      )
    ).text,
  ).toContain("Shared original evidence");
  expect((await provider.search({ query: "Personal" })).hits).toEqual([]);
  expect(await provider.get({ reference: personalRef })).toEqual({ status: "not_found" });
  expect((await f.service.record({ id: personal.id }, b)).record).toBeNull();
  await expect(
    f.service.evidence_read(
      { id: personal.id, path: upload.evidence!.path, sha256: upload.evidence!.sha256 },
      b,
    ),
  ).rejects.toThrow();
  await expect(
    f.service.attachment(
      { id: personal.id, path: upload.evidence!.path, sha256: upload.evidence!.sha256 },
      b,
    ),
  ).rejects.toThrow();
  const metadata = await Promise.all([
    f.service.grep({ query: "Personal" }, b),
    f.service.lookup({ query: "Personal sentinel" }, b),
    f.service.ontology({ includeRecords: true }, b),
    f.service.diagnostics({}, b),
    f.service.timeline({}, b),
  ]);
  expect(JSON.stringify(metadata)).not.toMatch(
    new RegExp(personal.id + "|Personal sentinel|Personal recall sentinel"),
  );
  expect(JSON.stringify(await provider.health())).not.toContain("Personal");
  expect(JSON.stringify(await f.index("research"))).toContain("Orchid decision");
  expect(JSON.stringify(await f.index("main", cutoff))).not.toContain("Personal sentinel");
  expect((await provider.candidates!({ kind: "trigger" })).hits).toEqual([]);
  await expect(f.save(b, "Denied save")).rejects.toThrow(/read-only/);
  await expect(f.service.person_grants({}, b)).rejects.toThrow(/administrator/);
  await expect(
    f.service.attach_file(
      {
        requestId: randomUUID(),
        filename: "original.txt",
        attribution: "Synthetic",
        filePath: "private.txt",
        sha256: "0".repeat(64),
      },
      a,
    ),
  ).rejects.toThrow(/byte uploads/);
  await expect(personalProvider.get({ reference: personalRef })).rejects.toThrow(/authority/);
  // Same display project for a different canonical person does not share a partition.
  await f.grant("research", "orchid", "read", "person-q");
  expect((await (await f.open("research", "person-q")).search({ query: "Orchid" })).hits).toEqual(
    [],
  );
  // Membership remains an independent ceiling on the person grant.
  f.host.config.plugins.entries.knowledge.config.stores = { work: { agents: ["main"] } };
  await expect(f.service.records({}, b)).rejects.toThrow(/person.*grant/);
});

it("revocation fences warmed provider leases and indexes and persists across a cold service restart", async () => {
  const f = fixture();
  await f.grant("main", "orchid");
  await f.grant("research", "orchid");
  await f.save(f.person(), "Orchid persistent");
  const provider = await f.open("research");
  const ref = (await provider.search({ query: "Orchid" })).hits[0]!.reference;
  expect(JSON.stringify(await f.index("research"))).toContain("Orchid persistent");
  await f.grant("research", "orchid", "none");
  await expect(provider.get({ reference: ref })).rejects.toThrow(/person.*grant/);
  await expect(provider.search({ query: "Orchid" })).rejects.toThrow(/person.*grant/);
  await expect(provider.health()).rejects.toThrow(/person.*grant/);
  await expect(provider.candidates!({ kind: "project" })).rejects.toThrow(/person.*grant/);
  expect(await f.index("research")).toBeUndefined();
  await f.restart();
  await expect(f.open("research")).rejects.toThrow(/person.*grant/);
  await expect(f.service.record({ id: ref.id }, f.person("research"))).rejects.toThrow(
    /person.*grant/,
  );
  expect(await f.index("research")).toBeUndefined();
  expect((await f.service.records({}, f.person())).total).toBe(1);
});

it("fences old person authority when a committed revocation loses its registry reply", async () => {
  const calls = vi.spyOn(RegistryClient.prototype, "callGuarded");
  afterTest(() => {
    calls.mockRestore();
  });
  const f = fixture();
  await f.grant("main", "orchid");
  await f.grant("research", "orchid");
  await f.save(f.person(), "Orchid uncertain revocation");
  const provider = await f.open("research");
  const ref = (await provider.search({ query: "Orchid" })).hits[0]!.reference;
  expect(JSON.stringify(await f.index("research"))).toContain("Orchid uncertain revocation");
  const registry = calls.mock.contexts.find((context) => context instanceof RegistryClient);
  if (!registry) {
    throw new Error("Expected the native registry client");
  }
  // Observe the real worker only to drop its post-commit transport reply.
  const worker = Reflect.get(registry, "worker") as Worker;
  const emit = worker.emit.bind(worker);
  let committed: RegistrySnapshot | undefined;
  let exit: Promise<number> | undefined;
  const delivery = vi.spyOn(worker, "emit").mockImplementation((event, ...args) => {
    const response = args[0] as RegistryResponse;
    if (event === "message" && response.type === "result" && response.ok && !exit) {
      committed = response.value as RegistrySnapshot;
      exit = worker.terminate();
      return false;
    }
    return emit(event, ...args);
  });
  afterTest(() => {
    delivery.mockRestore();
  });
  await expect(f.grant("research", "orchid", "none")).rejects.toThrow(/registry worker exited/);
  await exit;
  expect(committed).toBeDefined();
  expect(committed?.personGrants[personGrantKey("person-p", "research")]).toBeUndefined();
  await expect(provider.get({ reference: ref })).rejects.toThrow(/person.*grant|authority/);
  await expect(f.service.records({}, f.person("research"))).rejects.toThrow(/person.*grant/);
  await expect(f.open("research")).rejects.toThrow(/person.*grant/);
  expect(await f.index("research")).toBeUndefined();
  expect((await f.service.records({}, f.person())).total).toBe(1);
});

it("rechecks the original administrator at registry publication and rejects stale grant revisions", async () => {
  const f = fixture();
  const initial = await f.service.person_grants({}, f.admin);
  const input = {
    expectedRevision: initial.revision,
    profileId: "person-p",
    agent: "research",
    space: "orchid",
    access: "read" as const,
  };
  let checks = 0;
  const lost = operatorContext(f.api, ["operator.admin"], () => {
    if (++checks >= 4) {
      throw new Error("operator disconnected");
    }
  });
  await expect(f.service.person_grant(input, lost)).rejects.toThrow(/before grant publication/);
  expect((await f.service.person_grants({}, f.admin)).entries).toEqual([]);
  await f.grant("main", "personal");
  expect((await f.service.person_grant(input, f.admin)).outcome).toBe("conflict");
  await f.restart();
  await expect(f.service.records({}, f.person("research"))).rejects.toThrow(/person.*grant/);
});
