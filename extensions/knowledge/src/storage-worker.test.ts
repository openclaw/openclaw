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

async function startWithAuthority(assertInvocationCurrent: () => void) {
  const base = tempDirs.make("knowledge-worker-");
  const { root, config } = await createVault(base);
  const api = apiFor(base, config, { extra: { registerService: stopAtTestEnd } });
  const service = createKnowledgeService(api);
  const tool = toolContext(api);
  Object.assign(tool.tool, {
    sessionKey: "agent:main:test",
    sessionId: randomUUID(),
    assertInvocationCurrent,
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
  return { root, service, tool, save };
}

// Storage runs in a worker; authority checks it makes mid-operation are answered
// by the main thread. Revoking there must stop the write before it publishes.
it("authority revoked during a worker operation fails the write and publishes nothing", async () => {
  let checks = 0,
    allowed = Infinity;
  const { root, service, tool, save } = await startWithAuthority(() => {
    if (++checks > allowed) {
      throw new Error("invocation revoked");
    }
  });

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

// Host tool authority is scoped to each call's async context. The worker starts on
// the first call and stays warm; later calls must not be checked as that first call.
it("worker authority checks use each call's context, not the call that started the worker", async () => {
  const turn = new AsyncLocalStorage<string>();
  const retired = new Set<string>();
  const { service, tool, save } = await startWithAuthority(() => {
    const current = turn.getStore();
    if (!current || retired.has(current)) {
      throw new Error("tool invocation authority is no longer active");
    }
  });

  await turn.run("turn-1", () => save("First turn"));
  retired.add("turn-1");
  await turn.run("turn-2", () => save("Second turn"));
  const found = await turn.run("turn-2", () => service.lookup({ query: "Second turn" }, tool));
  expect(found.total).toBe(1);
  await expect(turn.run("turn-1", () => save("Late first turn"))).rejects.toThrow(
    /no longer active/,
  );
});
