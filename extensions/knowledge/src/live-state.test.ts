import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, rename, symlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { LiveState } from "./live-state.js";
import { createKnowledgeService } from "./service.js";
import {
  afterTest,
  apiFor,
  createVault,
  operatorContext,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

async function fixture() {
  const base = tempDirs.make("knowledge-live-");
  const { root, config } = await createVault(base);
  const services: any = [];
  const emitted: any = [];
  const api = apiFor(base, config, { extra: { registerService: (s: any) => services.push(s) } });
  const service = createKnowledgeService(api, { emit: (...args) => emitted.push(args) });
  afterTest(() => services.forEach((s: any) => s.stop()));
  return { base, root, services, emitted, service, context: operatorContext(api) };
}
async function until(fn: any) {
  for (let i = 0; i < 100; i++) {
    if (fn()) {
      return;
    }
    await delay(25);
  }
  expect.fail("Expected watcher notification");
}

it("external changes invalidate; events contain no data; authorized reads reconcile edits/renames/deletions", async () => {
  const f = await fixture();
  f.services[0].start();
  const r = await f.service.save_page(
    { requestId: randomUUID(), title: "Live fixture", type: "note", body: "Original" },
    f.context,
  );
  await until(() => f.emitted.length);
  await delay(200);
  f.emitted.length = 0;
  const original = (await f.service.record({ id: r.id, view: "raw" }, f.context)).record!.raw;
  const file = f.root + "/private/" + r.path;
  await writeFile(file, original!.replace("Original", "External edit"));
  await until(() => f.emitted.length);
  expect(f.emitted[0]).toStrictEqual(["changed", {}]);
  expect((await f.service.record({ id: r.id }, f.context)).record!.body).toBe("External edit");
  await delay(200);
  f.emitted.length = 0;
  await rename(file, file + "-renamed.md");
  await until(() => f.emitted.length);
  expect((await f.service.record({ id: r.id }, f.context)).record!.path).toBe(
    r.path + "-renamed.md",
  );
  await delay(200);
  f.emitted.length = 0;
  await rm(file + "-renamed.md"); // Native watchers can coalesce rapid rename/delete; periodic UI reads cover this.
  expect((await f.service.record({ id: r.id }, f.context)).record).toBe(null);
});

it("watcher stop cancels queued events; restart has one subscription; unrelated scopes stay silent", async () => {
  const f = await fixture(),
    live = new LiveState(f.root, () => f.emitted.push("event"));
  afterTest(() => live.stop());
  live.start();
  live.invalidate();
  live.stop();
  await delay(220);
  expect(f.emitted.length).toBe(0);
  live.start();
  live.start();
  live.invalidate();
  live.invalidate();
  await until(() => f.emitted.length);
  expect(f.emitted.length).toBe(1);
  await mkdir(f.root + "/conversations");
  await writeFile(f.root + "/conversations/foreign.txt", "private to a conversation");
  await delay(250);
  expect(f.emitted.length).toBe(1);
  await mkdir(f.root + "/private/.knowledge-history");
  await writeFile(f.root + "/private/.knowledge-history/stage", "hidden");
  await delay(250);
  expect(f.emitted.length).toBe(1);
});

it("watch failures are visible and unsafe roots are not watched", async () => {
  const f = await fixture();
  await symlink(f.root, f.base + "/alias");
  const live = new LiveState(f.base + "/alias", () => expect.fail("unsafe watch"));
  live.start();
  expect(live.state).toBe("unavailable");
  live.stop();
  expect(live.state).toBe("stopped");
});

it("retired services fence new and in-flight operations, leaving no accepted write", async () => {
  const f = await fixture();
  f.services[0].start();
  await f.service.status({}, f.context);
  const request = {
    requestId: randomUUID(),
    title: "Fenced",
    type: "note",
    body: "Never accepted",
  };
  const pending = f.service.save_page(request, f.context);
  f.services[0].stop();
  f.services[0].start();
  await expect(pending).rejects.toThrow(/reloaded/);
  expect((await f.service.mutation({ requestId: request.requestId }, f.context)).receipt).toBe(
    null,
  );
  f.services[0].stop();
  await expect(f.service.status({}, f.context)).rejects.toThrow(/reloaded/);
  await expect(f.service.save_page(request, f.context)).rejects.toThrow(/reloaded/);
  for (const operation of ["grep", "lookup"] as const) {
    await expect(f.service[operation]({ query: "Fenced" }, f.context)).rejects.toThrow(/reloaded/);
  }
});

it("status snapshot is stable for unchanged reads and detects equal-count edits and source corruption", async () => {
  const f = await fixture();
  const record = await f.service.save_page(
    {
      requestId: randomUUID(),
      title: "Snapshot",
      type: "note",
      body: "Original",
      source: { text: "Retained source", attribution: "test" },
    },
    f.context,
  );
  const before = await f.service.status({}, f.context);
  expect((await f.service.status({}, f.context)).snapshot).toBe(before.snapshot);
  const changed = await f.service.save_page(
    {
      requestId: randomUUID(),
      id: record.id,
      expectedRevision: record.revision,
      expectedHash: record.hash,
      title: "Snapshot",
      body: "Changed",
    },
    f.context,
  );
  const after = await f.service.status({}, f.context);
  expect(after.records).toBe(before.records);
  expect(after.snapshot).not.toBe(before.snapshot);
  const detail = await f.service.record({ id: changed.id, includeMetadata: true }, f.context);
  await writeFile(
    f.root + "/private/" + detail.record!.metadata!.evidence![0]!.path,
    "Corrupted source",
  );
  expect((await f.service.status({}, f.context)).snapshot).not.toBe(after.snapshot);
});

it("agent bylines follow exact journaled revisions, never scope ownership or source attribution", async () => {
  const f = await fixture();
  const agent = toolContext(f.context.api);
  const saved = await f.service.save_page(
    { requestId: randomUUID(), title: "Authored page", type: "note", body: "Agent text" },
    agent,
  );
  const record = (await f.service.record({ id: saved.id, view: "raw" }, f.context)).record;
  expect(record!.writtenByAgentId).toBe("main");
  expect(
    (await f.service.records({}, f.context)).records.find((r) => r.id === saved.id)!
      .writtenByAgentId,
  ).toBe("main");
  const operator = await f.service.save_page(
    { requestId: randomUUID(), title: "Operator page", type: "note", body: "Operator text" },
    f.context,
  );
  expect((await f.service.record({ id: operator.id }, f.context)).record!.writtenByAgentId).toBe(
    undefined,
  );
  await writeFile(
    f.root + "/private/" + saved.path,
    record!.raw!.replace("Agent text", "External text"),
  );
  expect((await f.service.record({ id: saved.id }, f.context)).record!.writtenByAgentId).toBe(
    undefined,
  );
});
