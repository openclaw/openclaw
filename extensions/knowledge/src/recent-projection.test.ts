import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { recentActivity } from "./recent-activity.js";
import { afterTest } from "./test-support.js";

// Recent reads a projection of published plans. It must follow publications
// made after it was built, and repair removals it did not see.
it("Recent projection follows later publications and removed requests", () => {
  const db = new DatabaseSync(":memory:");
  afterTest(() => db.close());
  db.exec(`CREATE TABLE history(sequence INTEGER PRIMARY KEY, scope TEXT,id TEXT,hash TEXT,revision INTEGER,provenance TEXT,at TEXT);
    CREATE TABLE mutations(scope TEXT,request TEXT,intent TEXT,state TEXT,plan TEXT,receipt TEXT, PRIMARY KEY(scope,request));
    CREATE TABLE recent_requests_v1(scope TEXT,request TEXT,operation TEXT,target_id TEXT,at TEXT,reason TEXT,replacement_id TEXT, PRIMARY KEY(scope,request));
    CREATE TABLE recent_records_v1(scope TEXT,request TEXT,ordinal INTEGER,id TEXT,hash TEXT,revision,actor TEXT,kind TEXT,type TEXT,title TEXT, PRIMARY KEY(scope,request,ordinal));`);
  const at = "2026-10-01T00:00:00Z",
    active: any = [];
  const publish = (request: any, id: any, state = "published") => {
    const record = {
      id,
      title: id,
      kind: "claim",
      type: "fact",
      path: `claims/${id}.md`,
      lifecycle: "active",
      revision: 1,
      valid: true,
      hash: id.padEnd(64, "0"),
      raw: "",
      body: "x",
      metadata: { recorded_at: at, updated_at: at, claim_kind: "fact" },
    };
    active.push(record);
    db.prepare(
      "INSERT INTO history(scope,id,hash,revision,provenance,at) VALUES (?,?,?,?,?,?)",
    ).run("private", id, record.hash, 1, "agent", at);
    db.prepare("INSERT INTO mutations VALUES (?,?,?,?,?,?)").run(
      "private",
      request,
      "i",
      state,
      JSON.stringify({ actor: "agent", record }),
      JSON.stringify({ id, at }),
    );
  };
  const ids = () =>
    recentActivity(db, "private", active, { limit: 20 }).items.map((item) => [
      item.id,
      item.change,
    ]);
  publish("r1", "a");
  expect(ids()).toStrictEqual([["a", "created"]]);
  publish("r2", "b");
  publish("r3", "c", "accepted");
  expect(ids(), "later publication projected; unpublished stays an observation").toStrictEqual([
    ["c", "observed"],
    ["b", "created"],
    ["a", "created"],
  ]);
  db.prepare("UPDATE mutations SET state='published' WHERE request='r3'").run();
  expect(ids(), "a request published after projection is picked up").toStrictEqual([
    ["c", "created"],
    ["b", "created"],
    ["a", "created"],
  ]);
  db.prepare("DELETE FROM mutations WHERE request='r2'").run();
  expect(ids(), "a removed request leaves the projection").toStrictEqual([
    ["c", "created"],
    ["b", "observed"],
    ["a", "created"],
  ]);
  expect(db.prepare("SELECT COUNT(*) n FROM recent_records_v1").get()!.n).toBe(2);
});
