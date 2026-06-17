import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginLogger } from "../../api.js";
import { PendingTaskRegistry } from "./pending-store.js";
import type { PendingTask } from "./types.js";

const logger: PluginLogger = { info() {}, warn() {}, error() {}, debug() {} } as PluginLogger;

function task(id: string, overrides: Partial<PendingTask> = {}): PendingTask {
  const now = Date.now();
  return {
    id,
    kind: "crawl_refresh",
    uid: "1749",
    backendId: id,
    sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:s1",
    mercureTopic: "1749",
    delivery: {},
    title: null,
    createdAt: now,
    attempts: 0,
    notified: false,
    expiresAt: now + 3_600_000,
    ...overrides,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "leading-v2-notify-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("PendingTaskRegistry", () => {
  it("adds, updates, removes and prunes", () => {
    const r = new PendingTaskRegistry();
    r.add(task("a"));
    r.add(task("b", { expiresAt: Date.now() - 1 }));
    expect(r.all()).toHaveLength(2);

    r.update("a", { attempts: 3 });
    expect(r.all().find((t) => t.id === "a")?.attempts).toBe(3);

    expect(r.prune(Date.now())).toBe(1); // b expired
    expect(r.all()).toHaveLength(1);

    r.remove("a");
    expect(r.all()).toHaveLength(0);
  });

  it("persists to stateDir and reloads on a fresh registry", async () => {
    const file = join(dir, "pending.json");
    const r1 = new PendingTaskRegistry();
    await r1.init(file, logger);
    r1.add(task("keep"));
    await r1.flush();

    const r2 = new PendingTaskRegistry();
    await r2.init(file, logger);
    expect(r2.all().map((t) => t.id)).toEqual(["keep"]);
  });

  it("starts clean when the state file is missing", async () => {
    const r = new PendingTaskRegistry();
    await r.init(join(dir, "does-not-exist.json"), logger);
    expect(r.all()).toHaveLength(0);
  });
});
