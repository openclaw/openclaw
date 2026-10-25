import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { SqliteIdentityStore } from "./identity-store.js";
import type { LoadedRecord } from "./model.js";
import { createKnowledgeService } from "./service.js";
import {
  appendActivity,
  sessionActivity,
  returnedRecords,
  type ActivityOutput,
} from "./session-activity.js";
import { KnowledgeStorage } from "./storage.js";
import {
  hostApi,
  toolContext,
  operatorContext,
  createVault,
  plainAccess,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

const origin = (sessionId = "incarnation-a", toolCallId = randomUUID()) => ({
  sessionKey: "agent:main:activity",
  sessionId,
  toolCallId,
  operation: "save",
  at: new Date().toISOString(),
});
const context = (api: any, o = origin()) => ({
  ...toolContext(api),
  toolCallId: o.toolCallId,
  tool: { ...toolContext(api).tool, sessionKey: o.sessionKey, sessionId: o.sessionId },
});

it("session reads and writes survive service reload; retries, inspector reads, resets and agents stay separate", async () => {
  const dir = tempDirs.make("knowledge-activity-");
  const { api } = hostApi(dir, {
    agents: ["main", "other"],
    policy: { operatorRead: true, writesEnabled: true },
  });
  let service = createKnowledgeService(api);
  const o = origin(),
    ctx = context(api, o),
    op = operatorContext(api);
  const input = {
    requestId: randomUUID(),
    title: "Session panel proof",
    type: "note",
    body: "A useful page.",
  };
  const receipt = await service.save_page(input, ctx);
  await service.save_page(input, context(api)); // new tool call retry must not reattribute a write
  await service.record({ id: receipt.id }, context(api));
  await service.grep({ query: "panel" }, context(api));
  await service.record({ id: receipt.id }, op); // inspection is not agent activity
  const query = { sessionKey: o.sessionKey, sessionId: o.sessionId };
  const result = await service.session_activity(query, op);
  expect(Check(contract.operations.session_activity.output, result)).toBeTruthy();
  expect(result.items.map((x) => x.action)).toStrictEqual(["read", "read", "write"]);
  expect(result.items.map((x) => x.operation)).toStrictEqual(["search", "record", "save"]);
  expect(result.items.at(-1)!.toolCallId).toBe(o.toolCallId);
  service = createKnowledgeService(api);
  expect((await service.session_activity(query, op)).items.length).toBe(3);
  expect((await service.session_activity({ ...query, sessionId: "reset" }, op)).items.length).toBe(
    0,
  );
  expect(
    (await service.session_activity({ ...query, sessionKey: "other-session" }, op)).items.length,
  ).toBe(0);
  expect(
    // agent_query returns the proxied session_activity output untyped.
    (
      (await service.agent_query(
        { agent: "other", operation: "session_activity", input: query },
        op,
      )) as ActivityOutput
    ).items.length,
  ).toBe(0);
  await expect(service.session_activity(query, ctx)).rejects.toThrow(/operator/);
  await expect(service.session_activity(query, operatorContext(api, []))).rejects.toThrow(
    /authority/,
  );
  const page = await service.session_activity({ ...query, limit: 1 }, op);
  const older = await service.session_activity(
    { ...query, limit: 1, upper: page.upper, before: page.nextBefore! },
    op,
  );
  expect(page.items[0]!.sequence > older.items[0]!.sequence).toBeTruthy();
  expect((await service.session_activity({ ...query, filter: "write" }, op)).items.length).toBe(1);
  const record = await service.record({ id: receipt.id }, op);
  await service.withdraw(
    {
      requestId: randomUUID(),
      id: receipt.id,
      expectedRevision: record.record!.revision,
      expectedHash: record.record!.hash,
      reason: "Testing current eligibility",
    },
    ctx,
  );
  expect(
    (await service.session_activity(query, op)).items.length,
    "Withdrawn content is not exposed in session activity",
  ).toBe(0);
});

it("accepted write captures original session before recovery, and commits exactly once", async () => {
  const dir = tempDirs.make("knowledge-activity-recovery-");
  const { config } = await createVault(dir);
  const o = origin();
  const access = { ...plainAccess(), activity: o };
  let fail = true;
  const storage = new KnowledgeStorage(config, undefined, (stage) => {
    if (stage === "after-accept" && fail) {
      fail = false;
      throw new Error("interrupted");
    }
  });
  const input = {
    requestId: randomUUID(),
    title: "Recovered write",
    type: "note",
    body: "Survives interruption.",
  };
  await expect(storage.save(input, access, "agent")).rejects.toThrow(/interrupted/);
  const recovered = new KnowledgeStorage(config);
  recovered.resume({ ...plainAccess(), activity: origin("different-session") }, input.requestId);
  recovered.resume(plainAccess(), input.requestId);
  const rows = await recovered.sessionActivity(
    { sessionKey: o.sessionKey, sessionId: o.sessionId },
    plainAccess(),
  );
  expect(rows.items.length).toBe(1);
  expect(rows.items[0]!.toolCallId).toBe(o.toolCallId);
  expect(
    (
      await recovered.sessionActivity(
        { sessionKey: o.sessionKey, sessionId: "different-session" },
        plainAccess(),
      )
    ).items.length,
  ).toBe(0);
});

it("activity filters current eligibility before pagination and keeps partitions isolated", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE session_activity (sequence INTEGER PRIMARY KEY, scope TEXT, agent_id TEXT,
      session_key TEXT, session_id TEXT, call_id TEXT, operation TEXT, action TEXT, at TEXT, record_id TEXT,
      revision INTEGER, UNIQUE(scope,agent_id,session_id,call_id,operation,action,record_id,revision))`);
    // sessionActivity reads only the summary fields of active records.
    const active = [
      { id: "a", title: "Visible", kind: "page", type: "note", revision: 1 },
    ] as LoadedRecord[];
    const o = origin();
    for (let i = 0; i < 205; i++) {
      appendActivity(db, "private", "main", { ...o, toolCallId: String(i) }, "read", [
        { id: i === 0 || i === 204 ? "a" : "hidden", revision: 1 },
      ]);
    }
    appendActivity(db, "conversations/other", "main", o, "write", active);
    appendActivity(db, "private", "other", o, "write", active);
    const query = { sessionKey: o.sessionKey, sessionId: o.sessionId, limit: 1 };
    const first = sessionActivity(db, "private", "main", active, query);
    expect(first.items.length).toBe(1);
    expect(first.nextBefore).toBeTruthy();
    const second = sessionActivity(db, "private", "main", active, {
      ...query,
      before: first.nextBefore!,
      upper: first.upper,
    });
    expect(second.items.length).toBe(1);
    expect(second.nextBefore).toBe(null);
    expect(sessionActivity(db, "private", "main", [], query).items.length).toBe(0);
  } finally {
    db.close();
  }
});

it("read recording failure does not fail a successful read; revoked authority still fails delivery", async () => {
  const dir = tempDirs.make("knowledge-activity-failure-");
  const { config } = await createVault(dir);
  class FullDiskStore extends SqliteIdentityStore {
    override withDatabase(): never {
      throw new Error("disk full");
    }
  }
  const storage = new KnowledgeStorage(config, new FullDiskStore(config.statePath));
  const value = { record: { id: "a", revision: 1 } };
  expect(
    await storage.trackRead({ ...plainAccess(), activity: origin() }, "record", () => value),
  ).toStrictEqual(value);
  await expect(
    storage.trackRead(
      {
        ...plainAccess(),
        activity: origin(),
        assertCurrent() {
          throw new Error("revoked");
        },
      },
      "record",
      () => value,
    ),
  ).rejects.toThrow(/revoked/);
  expect(returnedRecords({ body: '{"id":"bogus","revision":1}', record: null })).toStrictEqual([]);
});
