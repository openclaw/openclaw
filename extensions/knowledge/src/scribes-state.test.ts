import { describe, expect, it, vi } from "vitest";
import { locationParams, readLocation } from "./page-location.js";
import {
  defaultOptions,
  repairMessage,
  scribeById,
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
  it("builds the approved per-attempt setup idempotency key", () => {
    expect(setupIdempotencyKey("memory", "agent:main:dock:1", "a1")).toBe(
      "knowledge:scribe:memory:agent:main:dock:1:a1",
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
    const review = setupMessage(
      scribeSetup("unlinked-review", "ongoing", defaultOptions("unlinked-review"), "main", "UTC"),
    );
    expect(review).toContain(
      'Follow the "Scribe setup" section of the knowledge-unlinked-claims skill',
    );
    expect(review, "the review scribe defaults to weekly").toContain(
      '{"scribe":"unlinked-review","mode":"ongoing","options":{"schedule":"45 3 * * 0"},"timezone":"UTC","agentId":"main"}',
    );
  });
});

describe("scribes state", () => {
  // One conversations scribe loaded through fake Gateway reads.
  async function conversationsScribe(world: {
    session?: { key: string; displayName: string; archived?: boolean; status?: string };
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
        return { sessions: params?.search === label && world.session ? [world.session] : [] };
      }
      return { messages: world.messages ?? [] };
    });
    const snapshots = await loadScribes({ request } as never, "main");
    return snapshots.find((snapshot) => snapshot.scribe.id === "conversations")!;
  }
  const session = { key: "agent:main:dock:1", displayName: "Scribe · Learn from conversations" };
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
    expect(snapshot.setup).toEqual(setup);
    const edited = await conversationsScribe({
      session,
      messages: [user("Knowledge scribe setup: nope\nx\n```json\n{}\n```")],
    });
    expect(edited.setup).toBeUndefined();
  });

  it("derives Available, Starting, On, Paused, Failing, Done and Needs reauthorization", async () => {
    const archived = { ...session, archived: true };
    const setup = scribeSetup(
      "conversations",
      "ongoing",
      { scope: "active", since: "30d", schedule: "0 4 * * *" },
      "main",
      "UTC",
    );
    const cases: [Parameters<typeof conversationsScribe>[0], string][] = [
      [{}, "available"],
      [{ session }, "available"],
      [{ session, messages: [user(setupMessage(setup))] }, "starting"],
      [
        { session: { ...session, status: "interrupted" }, messages: [user(setupMessage(setup))] },
        "failing",
      ],
      [{ session, job: job() }, "on"],
      [{ session, job: job({ enabled: false }) }, "paused"],
      [{ session, job: job(), messages: [result("failed")] }, "failing"],
      [{ session, job: job({ enabled: false }), messages: [result("failed")] }, "paused"],
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
      [{ session, messages: [result("on"), user(setupMessage(setup))] }, "starting"],
    ];
    for (const [world, status] of cases) {
      expect((await conversationsScribe(world)).status, JSON.stringify(world)).toBe(status);
    }
  });

  it("finds sessions by display name and jobs by declarationKey through Gateway reads", async () => {
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
          [scribeLabel(review)]: [{ key: "s-review", displayName: scribeLabel(review) }],
          [scribeLabel(memory)]: [
            { key: "s-memory-old", displayName: scribeLabel(memory), archived: true },
            { key: "s-memory", displayName: scribeLabel(memory) },
          ],
        };
        return { sessions: typeof params?.search === "string" ? (rows[params.search] ?? []) : [] };
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
      search: "Scribe · Review unlinked claims",
      archived: "all",
      limit: 20,
    });
    expect(request).toHaveBeenCalledWith("cron.list", {
      agentId: "main",
      includeDisabled: true,
      limit: 200,
      offset: 0,
    });
  });

  it("picks the job that targets the scribe's own conversation", async () => {
    const label = "Scribe · Learn from conversations";
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              ...job({ id: "old", enabled: false }),
              declarationKey: "knowledge:scribe:conversations",
              sessionTarget: "session:s-old",
            },
            {
              ...job({ id: "mine" }),
              declarationKey: "knowledge:scribe:conversations",
              sessionTarget: "session:s-conv",
            },
          ],
        };
      }
      if (method === "sessions.list") {
        return {
          sessions: params?.search === label ? [{ key: "s-conv", displayName: label }] : [],
        };
      }
      return { messages: [] };
    });
    const snapshots = await loadScribes({ request } as never, "main");
    const conversations = snapshots.find((snapshot) => snapshot.scribe.id === "conversations")!;
    expect([conversations.job?.id, conversations.status]).toEqual(["mine", "on"]);
  });

  it("uses the conversation the automation targets over a newer one with the same title", async () => {
    const label = "Scribe · Learn from conversations";
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "cron.list") {
        return {
          jobs: [
            {
              ...job({ id: "mine" }),
              declarationKey: "knowledge:scribe:conversations",
              sessionTarget: "session:s-owner",
            },
          ],
        };
      }
      if (method === "sessions.list") {
        return {
          sessions:
            params?.search === label
              ? [
                  { key: "s-newer", displayName: label },
                  { key: "s-owner", displayName: label },
                  { key: "s-other", displayName: "Something else" },
                ]
              : [],
        };
      }
      return { messages: [] };
    });
    const snapshots = await loadScribes({ request } as never, "main");
    const conversations = snapshots.find((snapshot) => snapshot.scribe.id === "conversations")!;
    expect([conversations.session?.key, conversations.job?.id]).toEqual(["s-owner", "mine"]);
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
