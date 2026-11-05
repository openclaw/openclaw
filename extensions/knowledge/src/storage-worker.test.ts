import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createKnowledgeService } from "./service.js";
import {
  apiFor,
  createVault,
  stopAtTestEnd,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

// Storage runs in a worker; authority checks it makes mid-operation are answered
// by the main thread. Revoking there must stop the write before it publishes.
it("authority revoked during a worker operation fails the write and publishes nothing", async () => {
  const base = tempDirs.make("knowledge-worker-");
  const { root, config } = await createVault(base);
  const api = apiFor(base, config, { extra: { registerService: stopAtTestEnd } });
  const service = createKnowledgeService(api);
  let checks = 0,
    allowed = Infinity;
  const tool = toolContext(api);
  Object.assign(tool.tool, {
    sessionKey: "agent:main:test",
    sessionId: randomUUID(),
    assertInvocationCurrent: () => {
      if (++checks > allowed) {
        throw new Error("invocation revoked");
      }
    },
  });
  const save = (title: any) =>
    service.save_page(
      {
        requestId: randomUUID(),
        expectedVaultId: config.vaultId,
        type: "note",
        title,
        body: "Body",
      },
      tool,
    );

  await save("Warm up");
  const perSave = checks;
  expect(perSave > 2, "the worker re-checks authority during a write").toBeTruthy();
  // Allow only the main thread's checks before dispatch (pin, open, lane start,
  // client dispatch); the first worker-side check revokes.
  checks = 0;
  allowed = 4;
  await expect(save("Revoked mid-write")).rejects.toThrow(/invocation revoked/);
  allowed = Infinity;
  const notes = await readdir(path.join(root, "private", "notes"));
  expect(
    notes.filter((name) => name.startsWith("revoked")).length,
    "nothing published after revocation",
  ).toBe(0);
  expect((await service.lookup({ query: "Revoked mid-write" }, tool)).total).toBe(0);
  expect((await service.lookup({ query: "Warm up" }, tool)).total).toBe(1);
});

// The host scopes tool authority to each call's async context. The worker starts
// on the first call and stays warm, so its replies must not answer later calls'
// authority checks from that first call's retired context.
it("worker authority checks run in each call's own context, not the call that started the worker", async () => {
  const base = tempDirs.make("knowledge-worker-context-");
  const { config } = await createVault(base);
  const api = apiFor(base, config, { extra: { registerService: stopAtTestEnd } });
  const service = createKnowledgeService(api);
  const turn = new AsyncLocalStorage<string>();
  const retired = new Set<string>();
  const tool = toolContext(api);
  Object.assign(tool.tool, {
    sessionKey: "agent:main:test",
    sessionId: randomUUID(),
    assertInvocationCurrent: () => {
      const current = turn.getStore();
      if (!current || retired.has(current)) {
        throw new Error("tool invocation authority is no longer active");
      }
    },
  });
  const save = (title: string) =>
    service.save_page(
      {
        requestId: randomUUID(),
        expectedVaultId: config.vaultId,
        type: "note",
        title,
        body: "Body",
      },
      tool,
    );

  await turn.run("turn-1", () => save("First turn"));
  retired.add("turn-1");
  await expect(turn.run("turn-2", () => save("Second turn"))).resolves.toBeDefined();
  await expect(
    turn.run("turn-2", () => service.lookup({ query: "Second turn" }, tool)),
  ).resolves.toMatchObject({ total: 1 });
  // A retired turn's own late call still fails closed.
  await expect(turn.run("turn-1", () => save("Late first turn"))).rejects.toThrow(
    /no longer active/,
  );
});
