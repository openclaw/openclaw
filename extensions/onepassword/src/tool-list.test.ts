import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnePasswordBroker, type StandingGrant } from "./broker.js";
import { parseOnePasswordConfig } from "./config.js";
import { MemoryKeyedStore } from "./memory-store.test-support.js";
import { createOnePasswordTool } from "./tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const NOW = 10_000;
const invocation = { agentId: "agent-a", sessionKey: "session-a", sessionId: "conversation-a" };

const hash = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const grantKey = (slug: string) => hash([invocation.agentId, slug]);

function grant(slug: string): StandingGrant {
  return {
    agentId: invocation.agentId,
    slug,
    grantedAtMs: NOW - 1,
    expiresAtMs: NOW + 60_000,
    targetFingerprint: hash(["Automation", slug, "credential"]),
  };
}

describe("onepassword list with SQLite grants", () => {
  let env: NodeJS.ProcessEnv;
  let grants: PluginStateKeyedStore<StandingGrant, 2>;

  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("onepassword-list-") };
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    grants = createPluginStateKeyedStoreV2ForTests<StandingGrant>(
      "onepassword",
      { namespace: "grants", maxEntries: 1_024, overflowPolicy: "evict-oldest", env },
      { assertCurrent() {} },
    );
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  function storedRows() {
    const { db } = openOpenClawStateDatabase({ env });
    const insert = db.prepare(
      "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES ('onepassword', 'grants', ?, ?, ?, ?)",
    );
    return {
      insert: (key: string, json: string, created = NOW, expires: number | null = null) =>
        insert.run(key, json, created, expires),
      rows: () => db.prepare("SELECT * FROM plugin_state_entries ORDER BY entry_key").all(),
    };
  }

  function setup(slugs: string[], store = grants) {
    const broker = new OnePasswordBroker({
      resolveConfig: () =>
        parseOnePasswordConfig({
          vault: "Automation",
          items: Object.fromEntries(slugs.map((slug) => [slug, { item: slug }])),
        }),
      opClient: {
        getItem: async () => {
          throw new Error("list must not retrieve a secret");
        },
      },
      stores: { grants: store, audit: new MemoryKeyedStore(), pending: new MemoryKeyedStore() },
    });
    return (agentId: string | undefined = invocation.agentId) =>
      createOnePasswordTool(broker, { ...invocation, agentId }).execute("list", { action: "list" });
  }

  it("validates selected grants", async () => {
    const slugs = ["wrong-slug", "wrong-agent", "retargeted", "missing", "expired", "active"];
    for (const slug of slugs.filter((value) => value !== "missing")) {
      await grants.register(grantKey(slug), {
        ...grant(slug),
        ...(slug === "wrong-agent" ? { agentId: "other" } : {}),
        ...(slug === "wrong-slug" ? { slug: "other" } : {}),
        ...(slug === "expired" ? { expiresAtMs: NOW } : {}),
        ...(slug === "retargeted" ? { targetFingerprint: "old-target" } : {}),
      });
    }
    const list = setup(slugs);
    expect((await list()).details).toEqual({
      ok: true,
      items: [...slugs].toSorted().map((slug) => ({
        slug,
        description: "",
        policy: "approve",
        standingGrantActive: slug === "active",
      })),
    });
  });

  it.each([false, true])("validates stored corruption (selected: %s)", async (selected) => {
    const key = grantKey("selected");
    // Seed malformed storage before reads or writes can publish a cached postimage.
    const { insert } = storedRows();
    insert(key, selected ? "{" : JSON.stringify(grant("selected")));
    insert("unrelated", "{");
    expect((await setup(["selected"])()).details).toMatchObject(
      selected
        ? { ok: false, error: { code: "PLUGIN_STATE_CORRUPT" } }
        : { ok: true, items: [{ slug: "selected", standingGrantActive: true }] },
    );
  });

  it("treats null and expired rows as inactive without changing stored rows", async () => {
    const { insert, rows } = storedRows();
    insert(grantKey("null-value"), "null");
    insert(grantKey("expired-row"), JSON.stringify(grant("expired-row")), NOW - 1, NOW);
    const before = rows();
    expect((await setup(["null-value", "expired-row"])()).details).toMatchObject({
      ok: true,
      items: [
        { slug: "expired-row", standingGrantActive: false },
        { slug: "null-value", standingGrantActive: false },
      ],
    });
    expect(rows()).toEqual(before);
  });

  it("skips grant reads without an agent and never retries a rejected bulk read", async () => {
    const lookupMany = vi.fn(async () => {
      throw new Error("grant read unavailable");
    });
    const list = setup(["selected"], { ...grants, lookupMany });
    expect((await list("")).details).toMatchObject({
      ok: true,
      items: [{ standingGrantActive: false }],
    });
    expect(lookupMany).not.toHaveBeenCalled();
    expect((await list()).details).toMatchObject({
      ok: false,
      error: { message: "grant read unavailable" },
    });
    expect(lookupMany).toHaveBeenCalledTimes(1);
  });
});
