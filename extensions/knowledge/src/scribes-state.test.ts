import { describe, expect, it, vi } from "vitest";
import { locationParams, readLocation } from "./page-location.js";
import {
  defaultOptions,
  repairPrompt,
  scribeById,
  scribeLabel,
  scribeSetup,
  setupIdempotencyKey,
  setupPrompt,
} from "./scribes-catalog.js";
import { detectSources, loadScribes, statusFromText, type ScribeJob } from "./scribes-state.js";

const job = (overrides: Partial<ScribeJob> = {}): ScribeJob => ({
  id: "job-review",
  declarationKey: "knowledge:scribe:claim-consolidation",
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

  it("writes an ongoing setup prompt as settings, numbered steps and its run message", () => {
    const setup = scribeSetup(
      "conversations",
      "ongoing",
      { scope: "all", since: "90d", schedule: "0 4 * * *" },
      "America/Los_Angeles",
    );
    const prompt = setupPrompt(setup);
    expect(prompt).toMatch(
      /^Set up the Knowledge scribe "Learn from conversations" in this conversation\./,
    );
    expect(prompt).toContain(
      [
        "Settings:",
        "- Runs daily at 4:00 AM America/Los_Angeles (cron `0 4 * * *`).",
        "- Conversations: active and archived, from the last 90 days.",
      ].join("\n"),
    );
    expect(prompt).toContain("declaration key `knowledge:scribe:conversations`");
    expect(prompt).toContain("Don't start a run from this turn");
    expect(prompt).toContain("`Scribe status: on — <one sentence: the automation");
    const runMessage = prompt.match(/Run message:\n\n```text\n([\s\S]+)\n```$/)?.[1] ?? "";
    expect(runMessage).toMatch(
      /archived, from the last 90 days\.[\s\S]*"Learn from conversations"/,
    );
    expect(runMessage).toContain("This run can't change automations");
    expect(runMessage).not.toContain("With the automations tool");
    expect(prompt, "no JSON in the prompt").not.toMatch(/[{}]|```json|SCRIBE_RESULT/);
  });

  it("writes a once prompt that does the work in this turn, and defaults the review to weekly", () => {
    const once = scribeSetup("conversations", "once", defaultOptions("conversations"), "UTC");
    expect(once.options).toEqual({ scope: "active", since: "30d" });
    const memory = setupPrompt(
      scribeSetup("memory", "once", { sources: ["memory-md", "dreams"] }, "UTC"),
    );
    expect(memory).toContain("- Runs once, now, in this turn. Nothing is scheduled.");
    expect(memory).toContain("- Memory files: MEMORY.md and the Dreaming diary (DREAMS.md).");
    expect(memory).toContain("`Scribe status: done — <one sentence with counts");
    expect(memory).not.toMatch(/Run message|automations tool/);
    const review = setupPrompt(
      scribeSetup("claim-consolidation", "ongoing", defaultOptions("claim-consolidation"), "UTC"),
    );
    expect(review).toContain("- Runs weekly, Sundays at 3:45 AM UTC (cron `45 3 * * 0`).");
    expect(review).toContain("The knowledge-claim-consolidation skill does the work on each run.");
  });

  it("writes a repair prompt that keeps the automation's schedule and run message", () => {
    const prompt = repairPrompt("claim-consolidation", {
      schedule: { kind: "cron", expr: "45 3 * * *", tz: "UTC" },
      runMessage: "Edited run message",
    });
    expect(prompt).toMatch(/^Repair the Knowledge scribe "Knowledge Consolidation"/);
    expect(prompt).toContain("- Runs nightly at 3:45 AM UTC (cron `45 3 * * *`).");
    expect(prompt).toContain("leave it as it is and go to the last step");
    expect(prompt.endsWith("```text\nEdited run message\n```")).toBe(true);
    expect(
      repairPrompt("claim-consolidation", {
        schedule: { kind: "cron", expr: "5 1 * * 2", tz: "UTC" },
      }),
    ).toContain("- Runs on cron `5 1 * * 2`, time zone UTC.");
  });

  it("reads a status line tolerantly", () => {
    const cases: [string, string?, string?][] = [
      ["Filed.\nScribe status: on — 9 filed, 2 left", "on", "9 filed, 2 left"],
      ["**Scribe status:** Done – 12 saved", "done", "12 saved"],
      ["`Scribe status: failed - not writable`", "failed", "not writable"],
      ["_Scribe status: on — next run America/Los_Angeles_", "on", "next run America/Los_Angeles"],
      ["scribe status: on", "on", ""],
      ["Scribe status: maybe — x"],
      ["All done."],
    ];
    for (const [text, state, summary] of cases) {
      expect(statusFromText(text), text).toEqual(state ? { state, summary } : undefined);
    }
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
  const result = (state: string) => assistant(`Scribe status: ${state} — x`);
  const start = user("Set up the Knowledge scribe, as edited by hand.");

  it("reads the newest status line from assistant messages", async () => {
    const snapshot = await conversationsScribe({
      session,
      messages: [
        assistant("Scribe status: on — old"),
        user("Scribe status: failed — quoted"),
        assistant("Read 12 conversations.\n**Scribe status:** done — 12 saved"),
        assistant("No status here."),
      ],
    });
    expect(snapshot.result).toEqual({ state: "done", summary: "12 saved" });
    expect(
      (await conversationsScribe({ session, messages: [assistant("none")] })).result,
    ).toBeUndefined();
  });

  it("derives Available, Starting, On, Paused, Failing, Done and Needs reauthorization", async () => {
    const archived = { ...session, archived: true };
    const cases: [Parameters<typeof conversationsScribe>[0], string][] = [
      [{}, "available"],
      [{ session }, "available"],
      [{ session, messages: [start] }, "starting"],
      [{ session: { ...session, status: "interrupted" }, messages: [start] }, "failing"],
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
      [{ session, messages: [result("on"), start] }, "starting"],
    ];
    for (const [world, status] of cases) {
      expect((await conversationsScribe(world)).status, JSON.stringify(world)).toBe(status);
    }
  });

  it("finds sessions by display name and jobs by declarationKey through Gateway reads", async () => {
    const review = scribeById("claim-consolidation")!,
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
                user(setupPrompt(scribeSetup("memory", "once", { sources: ["memory-md"] }, "UTC"))),
                assistant("Saved what Memory knew.\nScribe status: done — Saved 4"),
              ],
            }
          : { messages: [] };
      }
      throw new Error(`unexpected ${method}`);
    });
    const snapshots = await loadScribes({ request } as never, "main");
    expect(snapshots.map((s) => [s.scribe.id, s.status, s.session?.key, s.job?.id])).toEqual([
      ["claim-consolidation", "on", "s-review", "job-review"],
      ["conversations", "available", undefined, undefined],
      ["memory", "done", "s-memory", undefined],
    ]);
    expect(snapshots[2]!.result).toEqual({ state: "done", summary: "Saved 4" });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      search: "Scribe · Knowledge Consolidation",
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
