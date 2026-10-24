import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { memoryPrincipal } from "./access.js";
import type { MemoryCallerContext } from "./memory-provider-types.js";
import { createKnowledgeService } from "./service.js";
import { accessFor, apiFor, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

type SessionAuthority = Extract<MemoryCallerContext["authority"], { kind: "session" }>;
const memoryScope = (context: any, agent = "main") => memoryPrincipal(context, agent, true)().scope;

function authority(...args: any[]) {
  // An explicit undefined audience is distinct from an omitted one.
  const audience = args.length === 0 ? { kind: "owner-private", agentId: "main" } : args[0];
  let invocationActive = true,
    audienceActive = true;
  const api = {};
  const assertInvocationCurrent = () => {
    if (!invocationActive) {
      throw new Error("invocation revoked");
    }
  };
  const assertMemoryAudienceCurrent = () => {
    if (!audienceActive) {
      throw new Error("audience revoked");
    }
  };
  const tool: any = {
    source: "tool",
    api,
    tool: {
      agentId: "main",
      memoryAudience: audience,
      assertInvocationCurrent,
      assertMemoryAudienceCurrent,
    },
  };
  const memory: MemoryCallerContext = {
    authority: {
      kind: "session",
      sessionKey: "agent:main:test",
      sessionId: randomUUID(),
      sandboxed: false,
      audience,
    },
    assertCurrent() {
      assertInvocationCurrent();
      assertMemoryAudienceCurrent();
    },
  };
  return {
    api,
    tool,
    memory,
    access: () => accessFor(tool, true),
    revokeInvocation() {
      invocationActive = false;
    },
    revokeAudience() {
      audienceActive = false;
    },
  };
}

it("host audiences map identically for native tools and provider access", () => {
  const sessionId = randomUUID();
  for (const [audience, expected] of [
    [{ kind: "owner-private", agentId: "main" }, { visibility: "private" }],
    [
      { kind: "conversation", agentId: "main", sessionKey: "agent:main:group", sessionId },
      { visibility: "conversation", sessionId },
    ],
  ]) {
    const f = authority(audience);
    expect(f.access().scope).toStrictEqual(expected);
    expect(memoryScope(f.memory)).toStrictEqual(expected);
  }
});

it("missing, foreign, sandboxed, host, and revoked authority is denied", () => {
  const missing = authority(undefined);
  expect(missing.access).toThrow(/no memory audience/);
  expect(() => memoryScope(missing.memory)).toThrow(/no memory audience/);
  // Another agent's audience resolves that agent, never the requested one.
  const foreign = authority({ kind: "owner-private", agentId: "other" });
  expect(foreign.access().agentId).toBe("other");
  expect(() => memoryScope(foreign.memory, "main")).toThrow(/authority/);
  const sandboxed = authority();
  // authority() always builds a session authority.
  (sandboxed.memory.authority as SessionAuthority).sandboxed = true;
  expect(() => memoryScope(sandboxed.memory)).toThrow(/authority/);
  const host = authority();
  host.memory.authority = { kind: "host", operation: "bootstrap" };
  expect(() => memoryScope(host.memory)).toThrow(/authority/);
  for (const revoke of ["revokeInvocation", "revokeAudience"] as const) {
    const f = authority(),
      access = f.access();
    f[revoke]();
    expect(access.assertCurrent).toThrow(/revoked/);
  }
});

async function serviceFixture() {
  const root = tempDirs.make("knowledge-audience-");

  const vault = path.join(root, "vault"),
    sessionId = randomUUID();
  await mkdir(path.join(vault, "private"), { recursive: true });
  await mkdir(path.join(vault, "conversations", sessionId), { recursive: true });
  const vaultId = randomUUID(),
    publicationId = randomUUID();
  await writeFile(
    path.join(vault, "vault.json"),
    JSON.stringify({
      format: "knowledge-vault-v2",
      vaultId,
      generation: 0,
      publicationId,
    }),
  );
  const owner = authority({ kind: "owner-private", agentId: "main" });
  const conversation = authority({
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId,
  });
  const config = {
    root: vault,
    statePath: path.join(root, "knowledge.sqlite"),
    vaultId,
    publicationId,
    writesEnabled: true,
    operatorRead: true,
  };
  let memory: any;
  const api = apiFor(root, config, {
    extra: {
      registerMemoryCapability(c: any) {
        memory = c.providerRuntime;
      },
    },
  });
  owner.tool.api = api;
  conversation.tool.api = api;
  const service = createKnowledgeService(api);
  const save = (title: any, context: any) =>
    service.save_page(
      {
        requestId: randomUUID(),
        expectedVaultId: vaultId,
        type: "note",
        title,
        body: "Synthetic host-audience regression evidence.",
      },
      context.tool,
    );
  return {
    owner,
    conversation,
    service,
    save,
    open: (context: any) => memory.open({ cfg: {}, agentId: "main", context: context.memory }),
  };
}

it("owner-private and conversation audiences remain partition-isolated", async () => {
  const f = await serviceFixture();
  const privateRecord = await f.save("Private sentinel", f.owner);
  const conversationRecord = await f.save("Conversation sentinel", f.conversation);
  expect((await f.service.record({ id: privateRecord.id }, f.conversation.tool)).record).toBe(null);
  expect((await f.service.record({ id: conversationRecord.id }, f.owner.tool)).record).toBe(null);
  const { provider } = await f.open(f.conversation);
  const hits = await provider.search({ query: "sentinel" });
  expect(hits.hits.map((hit: any) => hit.reference.id)).toStrictEqual([conversationRecord.id]);
  await provider.close();
});

it("audience revocation stops retained reads and new writes", async () => {
  const f = await serviceFixture();
  await f.save("Private sentinel", f.owner);
  const { provider } = await f.open(f.owner);
  f.owner.revokeAudience();
  await expect(provider.search({ query: "sentinel" })).rejects.toThrow(/audience revoked/);
  await expect(f.save("Must not publish", f.owner)).rejects.toThrow(/audience revoked/);
});
