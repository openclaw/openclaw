import { describe, expect, it, vi } from "vitest";
import { locationParams, readLocation } from "./page-location.js";
import {
  SCRIBES,
  repairMessage,
  scribeById,
  scribeDeclarationKey,
  scribeLabel,
  scribeSetup,
  setupIdempotencyKey,
  setupMessage,
} from "./scribes-catalog.js";
import { detectSources, loadScribes, type ScribeJob } from "./scribes-state.js";

const job = (overrides: Partial<ScribeJob> = {}): ScribeJob => ({
  id: "job-review",
  declarationKey: "knowledge:scribe:unlinked-review",
  enabled: true,
  configRevision: "rev-1",
  schedule: { kind: "cron", expr: "45 3 * * *", tz: "America/Los_Angeles" },
  state: { lastRunStatus: "ok", lastRunAtMs: 1_793_000_000_000 },
  ...overrides,
});
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const user = (text: string) => ({ role: "user", content: text });

describe("scribes catalog", () => {
  it("lists the three scribes with their labels, keys, modes and skills", () => {
    expect(
      SCRIBES.map((s) => [s.id, scribeLabel(s), scribeDeclarationKey(s.id), s.modes, s.skill]),
    ).toEqual([
      [
        "unlinked-review",
        "Scribe · Review unlinked claims",
        "knowledge:scribe:unlinked-review",
        ["ongoing"],
        "knowledge-unlinked-claims",
      ],
      [
        "conversations",
        "Scribe · Learn from conversations",
        "knowledge:scribe:conversations",
        ["ongoing", "once"],
        "knowledge-ingest",
      ],
      [
        "memory",
        "Scribe · Learn from Memory",
        "knowledge:scribe:memory",
        ["once"],
        "knowledge-ingest",
      ],
    ]);
    expect(setupIdempotencyKey("memory", "agent:main:dock:1")).toBe(
      "knowledge:scribe:memory:agent:main:dock:1",
    );
  });

  it("emits exactly the shared setup format: fixed text plus options JSON", () => {
    const setup = scribeSetup(
      "conversations",
      "ongoing",
      { scope: "all", since: "90d", schedule: "0 4 * * *" },
      "main",
      "America/Los_Angeles",
    );
    expect(setupMessage(setup)).toBe(
      [
        "Knowledge scribe setup: conversations",
        'Follow the "Scribe setup" section of the knowledge-ingest skill with these options.',
        "```json",
        '{"scribe":"conversations","mode":"ongoing","options":{"scope":"all","since":"90d","schedule":"0 4 * * *"},"timezone":"America/Los_Angeles","agentId":"main"}',
        "```",
      ].join("\n"),
    );
    expect(repairMessage(setup).split("\n")[0]).toBe("Knowledge scribe repair: conversations");
  });

  it("drops the schedule for a once conversations scribe and keeps memory sources", () => {
    expect(
      scribeSetup(
        "conversations",
        "once",
        { scope: "active", since: "30d", schedule: "0 4 * * *" },
        "main",
        "UTC",
      ).options,
    ).toEqual({ scope: "active", since: "30d" });
    expect(
      setupMessage(
        scribeSetup("memory", "once", { sources: ["memory-md", "dreams"] }, "main", "UTC"),
      ),
    ).toContain(
      '{"scribe":"memory","mode":"once","options":{"sources":["memory-md","dreams"]},"timezone":"UTC","agentId":"main"}',
    );
    expect(setupMessage(scribeSetup("unlinked-review", "ongoing", {}, "main", "UTC"))).toContain(
      'Follow the "Scribe setup" section of the knowledge-unlinked-claims skill',
    );
  });
});

describe("scribes state", () => {
  // One conversations scribe loaded through fake Gateway reads.
  async function conversationsScribe(world: {
    session?: { key: string; label: string; archived?: boolean };
    job?: ScribeJob;
    messages?: unknown[];
  }) {
    const label = "Scribe · Learn from conversations";
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "cron.list") {
        return {
          jobs: world.job
            ? [{ ...world.job, declarationKey: "knowledge:scribe:conversations" }]
            : [],
        };
      }
      if (method === "sessions.list") {
        return { sessions: params?.label === label && world.session ? [world.session] : [] };
      }
      return { messages: world.messages ?? [] };
    });
    const snapshots = await loadScribes({ request } as never, "main");
    return snapshots.find((snapshot) => snapshot.scribe.id === "conversations")!;
  }
  const session = { key: "agent:main:dock:1", label: "Scribe · Learn from conversations" };
  const result = (state: string) =>
    assistant(
      `SCRIBE_RESULT {"scribe":"conversations","state":"${state}","jobId":null,"summary":"x"}`,
    );

  it("reads the newest valid SCRIBE_RESULT line from assistant messages", async () => {
    const snapshot = await conversationsScribe({
      session,
      messages: [
        assistant(
          'SCRIBE_RESULT {"scribe":"conversations","state":"on","jobId":null,"summary":"old"}',
        ),
        user(
          'SCRIBE_RESULT {"scribe":"conversations","state":"failed","jobId":null,"summary":"quoted"}',
        ),
        assistant(
          'Read 12 conversations.\nSCRIBE_RESULT {"scribe":"conversations","state":"done","jobId":null,"summary":"12 saved"}',
        ),
        assistant("SCRIBE_RESULT {not json}"),
      ],
    });
    expect(snapshot.result).toEqual({
      scribe: "conversations",
      state: "done",
      jobId: null,
      summary: "12 saved",
    });
    expect(
      (await conversationsScribe({ session, messages: [assistant("none")] })).result,
    ).toBeUndefined();
  });

  it("recovers the options of the latest setup message", async () => {
    const setup = scribeSetup(
      "conversations",
      "once",
      { scope: "all", since: "all" },
      "main",
      "UTC",
    );
    const snapshot = await conversationsScribe({
      session,
      messages: [user(setupMessage(setup)), assistant("ok")],
    });
    expect(snapshot.setup).toEqual(JSON.parse(JSON.stringify(setup)));
    const edited = await conversationsScribe({
      session,
      messages: [user("Knowledge scribe setup: nope\nx\n```json\n{}\n```")],
    });
    expect(edited.setup).toBeUndefined();
  });

  it("derives Available, Starting, On, Paused, Failing, Done and Needs reauthorization", async () => {
    const archived = { ...session, archived: true };
    const cases: [Parameters<typeof conversationsScribe>[0], string][] = [
      [{}, "available"],
      [{ session }, "starting"],
      [{ session, job: job() }, "on"],
      [{ session, job: job({ enabled: false }) }, "paused"],
      [{ session, job: job({ state: { consecutiveErrors: 2 } }) }, "failing"],
      [
        {
          session,
          job: job({ enabled: false, state: { autoDisabled: { reason: "consecutive-failures" } } }),
        },
        "failing",
      ],
      [{ session, messages: [result("done")] }, "done"],
      [{ session, messages: [result("failed")] }, "failing"],
      [{ session, messages: [result("on")] }, "available"],
      [{ session: archived, job: job() }, "reauth"],
      [{ job: job() }, "reauth"],
      [{ session: archived }, "available"],
    ];
    for (const [world, status] of cases) {
      expect((await conversationsScribe(world)).status, JSON.stringify(world)).toBe(status);
    }
  });

  it("finds sessions by label and jobs by declarationKey through Gateway reads", async () => {
    const review = scribeById("unlinked-review")!,
      memory = scribeById("memory")!;
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "cron.list") {
        return {
          jobs: [job(), { id: "other", declarationKey: "something:else", enabled: true }],
          hasMore: false,
          nextOffset: null,
        };
      }
      if (method === "sessions.list") {
        const rows: Record<string, unknown[]> = {
          [scribeLabel(review)]: [{ key: "s-review", label: scribeLabel(review) }],
          [scribeLabel(memory)]: [
            { key: "s-memory-old", label: scribeLabel(memory), archived: true },
            { key: "s-memory", label: scribeLabel(memory) },
          ],
        };
        return { sessions: typeof params?.label === "string" ? (rows[params.label] ?? []) : [] };
      }
      if (method === "chat.history") {
        return params?.sessionKey === "s-memory"
          ? {
              messages: [
                user(
                  setupMessage(
                    scribeSetup("memory", "once", { sources: ["memory-md"] }, "main", "UTC"),
                  ),
                ),
                assistant(
                  'SCRIBE_RESULT {"scribe":"memory","state":"done","jobId":null,"summary":"Saved 4"}',
                ),
              ],
            }
          : { messages: [] };
      }
      throw new Error(`unexpected ${method}`);
    });
    const snapshots = await loadScribes({ request } as never, "main");
    expect(snapshots.map((s) => [s.scribe.id, s.status, s.session?.key, s.job?.id])).toEqual([
      ["unlinked-review", "on", "s-review", "job-review"],
      ["conversations", "available", undefined, undefined],
      ["memory", "done", "s-memory", undefined],
    ]);
    expect(snapshots[2]!.setup?.options).toEqual({ sources: ["memory-md"] });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      label: "Scribe · Review unlinked claims",
      archived: "all",
      limit: 5,
    });
    expect(request).toHaveBeenCalledWith("cron.list", {
      agentId: "main",
      includeDisabled: true,
      limit: 200,
      offset: 0,
    });
  });

  it("detects conversation counts and MEMORY.md, omitting what it cannot read", async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.list") {
        return params?.archived
          ? { sessions: [], count: 1 }
          : { sessions: [], count: 1, totalCount: 148 };
      }
      return { files: [{ name: "MEMORY.md", missing: false, size: 4096 }] };
    });
    expect(await detectSources({ request } as never, "main")).toEqual({
      activeConversations: 148,
      memoryFile: { size: 4096 },
    });
    const failing = vi.fn(async () => {
      throw new Error("missing scope");
    });
    expect(await detectSources({ request: failing } as never, "main")).toEqual({});
  });
});

describe("scribes location", () => {
  it("round-trips the Scribes tab and a scribe detail", () => {
    const detail = readLocation({ view: "scribes", scribe: "memory", agent: "main" });
    expect(detail).toMatchObject({ tab: "scribes", scribe: "memory", agent: "main" });
    expect(locationParams(detail)).toEqual({ agent: "main", view: "scribes", scribe: "memory" });
    expect(readLocation(locationParams(detail))).toEqual(detail);
    expect(readLocation({ view: "scribes", scribe: "nope" }).scribe).toBe("");
    expect(readLocation({ view: "browse", scribe: "memory" }).scribe).toBe("");
  });
});
