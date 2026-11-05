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
