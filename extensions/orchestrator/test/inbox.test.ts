import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  enqueueInboxMessage,
  inboxDir,
  readInboxMessages,
  removeInboxMessage,
} from "../src/inbox.js";

let agentsDir: string;
const opts = () => ({ agentsDir });

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "orchestrator-inbox-"));
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

describe("enqueueInboxMessage", () => {
  test("writes a JSON file under the agent's inbox/ dir", () => {
    const msg = enqueueInboxMessage(
      {
        taskId: "abc123",
        goal: "test goal",
        assignedAgentId: "coder",
        capabilities: ["code"],
      },
      opts(),
    );
    expect(msg.schemaVersion).toBe(1);
    expect(msg.taskId).toBe("abc123");
    const path = resolve(inboxDir(opts()), "abc123.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.assignedAgentId).toBe("coder");
    expect(parsed.enqueuedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("write is atomic — no .json.tmp left behind", () => {
    enqueueInboxMessage(
      {
        taskId: "abc123",
        goal: "g",
        assignedAgentId: "main",
        capabilities: [],
      },
      opts(),
    );
    expect(() => readFileSync(resolve(inboxDir(opts()), "abc123.json.tmp"), "utf8")).toThrow();
  });

  test("default enqueuedAt is the current time when not supplied", () => {
    const before = new Date();
    const msg = enqueueInboxMessage(
      {
        taskId: "z1",
        goal: "g",
        assignedAgentId: "main",
        capabilities: [],
      },
      opts(),
    );
    const after = new Date();
    const enqueued = new Date(msg.enqueuedAt);
    expect(enqueued.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(enqueued.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });
});

describe("readInboxMessages", () => {
  test("returns empty when the inbox dir is missing", () => {
    expect(readInboxMessages(opts())).toEqual([]);
  });

  test("ignores .json.tmp partial-write files", () => {
    enqueueInboxMessage(
      {
        taskId: "real",
        goal: "g",
        assignedAgentId: "main",
        capabilities: [],
      },
      opts(),
    );
    writeFileSync(resolve(inboxDir(opts()), "ghost.json.tmp"), "{}");
    expect(readInboxMessages(opts()).map((m) => m.taskId)).toEqual(["real"]);
  });

  test("skips schema-drifted messages without throwing", () => {
    enqueueInboxMessage(
      { taskId: "good", goal: "g", assignedAgentId: "main", capabilities: [] },
      opts(),
    );
    writeFileSync(resolve(inboxDir(opts()), "drift.json"), JSON.stringify({ schemaVersion: 99 }));
    expect(readInboxMessages(opts()).map((m) => m.taskId)).toEqual(["good"]);
  });

  test("returns messages sorted by enqueuedAt ascending", () => {
    enqueueInboxMessage(
      {
        taskId: "later",
        goal: "l",
        assignedAgentId: "main",
        capabilities: [],
        enqueuedAt: "2026-04-26T10:00:00.000Z",
      },
      opts(),
    );
    enqueueInboxMessage(
      {
        taskId: "earlier",
        goal: "e",
        assignedAgentId: "main",
        capabilities: [],
        enqueuedAt: "2026-04-26T08:00:00.000Z",
      },
      opts(),
    );
    expect(readInboxMessages(opts()).map((m) => m.taskId)).toEqual(["earlier", "later"]);
  });
});

describe("removeInboxMessage", () => {
  test("removes a previously enqueued message", () => {
    enqueueInboxMessage(
      { taskId: "x", goal: "g", assignedAgentId: "main", capabilities: [] },
      opts(),
    );
    expect(removeInboxMessage("x", opts())).toBe(true);
    expect(readInboxMessages(opts())).toEqual([]);
  });

  test("returns false when the message is already gone", () => {
    expect(removeInboxMessage("missing", opts())).toBe(false);
  });
});
