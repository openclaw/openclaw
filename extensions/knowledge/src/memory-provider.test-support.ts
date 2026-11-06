// Shared memory-provider fixture: a writable vault adopted by a host-like API whose
// memory capability registration is captured for provider-runtime tests.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createKnowledgeService } from "./service.js";
import { apiFor } from "./test-support.js";

/** A writable vault with owner-private tool and session contexts and a captured memory capability. */
export async function memoryFixture(tempDirs: { make(prefix: string): string }, overrides = {}) {
  const base = tempDirs.make("knowledge-memory-");

  const root = path.join(base, "vault");
  await mkdir(root);
  const vaultId = randomUUID(),
    publicationId = randomUUID(),
    sessionId = randomUUID();
  await mkdir(path.join(root, "private"));
  await mkdir(path.join(root, "conversations", sessionId), { recursive: true });
  await writeFile(
    path.join(root, "vault.json"),
    JSON.stringify({ format: "knowledge-vault-v2", vaultId, generation: 0, publicationId }),
  );
  let capability: any,
    active = true;
  const services: any = [];
  const hooks: Record<string, any> = {};
  const api = apiFor(
    base,
    {
      root,
      statePath: path.join(base, "state.sqlite"),
      vaultId,
      publicationId,
      operatorRead: true,
      writesEnabled: true,
      ...overrides,
    },
    {
      extra: {
        registerMemoryCapability(c: any) {
          capability = c;
        },
        registerService(s: any) {
          services.push(s);
        },
        on(name: string, handler: any) {
          hooks[name] = handler;
        },
      },
    },
  );
  const service = createKnowledgeService(api);
  const assertCurrent = () => {
    if (!active) {
      throw new Error("caller revoked");
    }
  };
  const audience = { kind: "owner-private", agentId: "main" };
  const context: any = {
    authority: {
      kind: "session",
      sessionKey: "agent:main:test",
      sessionId,
      sandboxed: false,
      audience,
    },
    assertCurrent,
  };
  const tool: any = {
    source: "tool",
    api,
    tool: {
      agentId: "main",
      memoryAudience: audience,
      assertInvocationCurrent: assertCurrent,
      assertMemoryAudienceCurrent: assertCurrent,
    },
  };
  const open = (ctx = context, agentId = "main", purpose?: any) =>
    capability.providerRuntime.open({
      cfg: {},
      agentId,
      context: ctx,
      ...(purpose ? { purpose } : {}),
    });
  const save = (title: any, body = "Evidence-backed durable note", ctx = tool) =>
    service.save_page(
      { requestId: randomUUID(), expectedVaultId: vaultId, type: "note", title, body },
      ctx,
    );
  // Read one record as the owner; extra selects views such as raw or full metadata.
  const current = async (id: string, extra = {}, ctx = tool) =>
    (await service.record({ id, ...extra }, ctx)).record!;
  // Optimistic-concurrency fields for a mutation of the record's current revision.
  const fence = (record: { id: string; revision: number; hash: string }) => ({
    requestId: randomUUID(),
    id: record.id,
    expectedRevision: record.revision,
    expectedHash: record.hash,
  });
  const recall = async (target: any, set: any, ctx = tool) =>
    service.recall({ ...fence(await current(target.id, {}, ctx)), set }, ctx);
  return {
    api,
    service,
    services,
    hooks,
    open,
    save,
    recall,
    current,
    fence,
    tool,
    context,
    sessionId,
    conversation: {
      kind: "conversation",
      agentId: "main",
      sessionKey: "agent:main:group",
      sessionId,
    },
    vaultId,
    root,
    capability,
    revoke() {
      active = false;
    },
    setAudience(value: any) {
      context.authority.audience = value;
      tool.tool.memoryAudience = value;
    },
  };
}
