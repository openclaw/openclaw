import { describe, expect, it, vi } from "vitest";
import { locationParams, readLocation } from "./page-location.js";
import {
  checkRunMessage,
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
  sessionTarget: "session:agent:main:dock:1",
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
    expect(prompt).toContain("Pass `enabled: true`");
    expect(prompt.endsWith("```text\nEdited run message\n```")).toBe(true);
    // Only this agent's automations are cleared or declared.
    expect(prompt).toContain("list automations for this agent (pass `agentId` from Runtime)");
    expect(prompt).toContain("never remove another agent's automation");
    expect(prompt).toContain("- agent: this agent's ID from Runtime");
    // Options the prompt doesn't set are passed on, so re-declaring keeps them.
    const saved = { model: "provider/model", activeHours: { start: "09:00", end: "17:00" } };
    expect(
      repairPrompt("claim-consolidation", { schedule: { kind: "cron" }, saved }, "update"),
    ).toContain(`exactly as written: \`${JSON.stringify(saved)}\``);
    expect(
      repairPrompt("claim-consolidation", {
        schedule: { kind: "cron", expr: "5 1 * * 2", tz: "UTC" },
      }),
    ).toContain("- Runs on cron `5 1 * * 2`, time zone UTC.");
  });

  it("writes a Granola prompt that names the meetings and the meeting-ingest work", () => {
    const prompt = setupPrompt(
      scribeSetup("granola", "ongoing", defaultOptions("granola"), "America/Los_Angeles"),
    );
    expect(prompt).toContain(
      [
        "- Runs weekdays at 10:00 AM, 2:00 PM and 6:00 PM America/Los_Angeles (cron `0 10,14,18 * * 1-5`).",
        "- Granola meetings: the owner's (recorded by them or with them invited), from the last 7 days.",
      ].join("\n"),
    );
    expect(prompt).toContain("declaration key `knowledge:scribe:granola`");
    const runMessage = prompt.match(/Run message:\n\n```text\n([\s\S]+)\n```$/)?.[1] ?? "";
    expect(runMessage).toContain(
      'Follow "Learn from Granola" in the "Scribe runs" section of the knowledge-meeting-ingest skill',
    );
    const once = setupPrompt(
      scribeSetup("granola", "once", { meetings: "all", since: "30d" }, "UTC"),
    );
    expect(once).toContain("Runs once, now, in this turn.");
    expect(once).toContain("including notes others shared, from the last 30 days.");
  });

  it("recognizes run messages earlier versions generated and keeps edited ones", () => {
    const runMessage = (id: "claim-consolidation" | "granola", options: object) =>
      setupPrompt(scribeSetup(id, "ongoing", options as never, "UTC")).match(
        /Run message:\n\n```text\n([\s\S]+)\n```$/,
      )![1]!;
    // The access step every run message carried before the never-written-store wording.
    const earlierOf = (message: string) =>
      message.replace(
        /writes are enabled; a never-written store [^.]+\./,
        "writes are enabled, or the store is unprovisioned (a vault that was never written reports writes off until its first write).",
      );
    // Consolidation as claim filing only, before runs followed every step of its skill.
    const claimsOnly = (message: string) =>
      message
        .replace(
          /Follow every step of [^\n]+ even when no claim is left to link\./,
          'Follow the "Scribe runs" section of the knowledge-claim-consolidation skill: consolidate every claim that names no page until none is left to decide.',
        )
        .replace(
          "withdrawn and left; Timelines retired and left; pages reviewed, changed and left unchanged",
          "withdrawn and left",
        );
    const current = runMessage("claim-consolidation", defaultOptions("claim-consolidation"));
    expect(current).toContain("Timelines retired and left; pages reviewed, changed");
    const earlier = claimsOnly(earlierOf(current));
    expect(checkRunMessage("claim-consolidation", current)).toEqual({ state: "current" });
    for (const message of [earlier, claimsOnly(current)]) {
      expect(message).not.toBe(current);
      expect(checkRunMessage("claim-consolidation", message)).toEqual({
        state: "outdated",
        current,
      });
    }
    expect(checkRunMessage("claim-consolidation", `${claimsOnly(current)}\nTidy titles.`)).toEqual({
      state: "differs",
      current,
    });
    expect(checkRunMessage("claim-consolidation", `${current}\nTidy titles.`)).toEqual({
      state: "custom",
    });
    const granola = runMessage("granola", { meetings: "all", since: "today" });
    const edited = earlierOf(granola).replace("left pending", "skipped and left for later");
    expect(checkRunMessage("granola", edited)).toEqual({ state: "differs", current: granola });
    // Granola runs gained the needs-attention rule; a message from before it is upgraded.
    expect(granola).toContain("end with `Scribe status: needs attention — <why>` instead.");
    const beforeAttention = granola.slice(
      0,
      granola.lastIndexOf("\n\nIf meetings are left pending"),
    );
    expect(checkRunMessage("granola", beforeAttention)).toEqual({
      state: "outdated",
      current: granola,
    });
    expect(checkRunMessage("granola", `${granola}\nAlso tag speakers.`)).toEqual({
      state: "custom",
    });
    expect(
      repairPrompt("claim-consolidation", { schedule: { kind: "cron" }, runMessage: earlier }),
    ).toContain(`\`\`\`text\n${current}\n\`\`\``);
    expect(repairPrompt("granola", { schedule: { kind: "cron" }, runMessage: edited })).toContain(
      edited,
    );
    expect(
      setupPrompt(scribeSetup("granola", "ongoing", defaultOptions("granola"), "UTC")),
    ).toContain("- session target: `current`, so each run starts in a fresh session");
  });

  it("reads a status line tolerantly", () => {
    const cases: [string, string?, string?][] = [
      ["Filed.\nScribe status: on — 9 filed, 2 left", "on", "9 filed, 2 left"],
      ["**Scribe status:** Done – 12 saved", "done", "12 saved"],
      ["`Scribe status: failed - not writable`", "failed", "not writable"],
      ["_Scribe status: on — next run America/Los_Angeles_", "on", "next run America/Los_Angeles"],
      ["scribe status: on", "on", ""],
      ["Scribe status: needs attention — 3 left pending", "needs-attention", "3 left pending"],
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
      if (method === "sessions.describe") {
        return { session: world.session?.key === params?.key ? world.session : null };
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

  it("derives Available, Starting, On, Paused, Failing, Done and Missing", async () => {
    const archived = { ...session, archived: true };
    const cases: [Parameters<typeof conversationsScribe>[0], string][] = [
      [{}, "available"],
      [{ session }, "available"],
      [{ session, messages: [start] }, "starting"],
      [{ session: { ...session, status: "interrupted" }, messages: [start] }, "failing"],
      [{ session, job: job() }, "on"],
      [{ session, job: job({ enabled: false }) }, "paused"],
      [{ session, job: job(), messages: [result("failed")] }, "failing"],
      [{ session, job: job(), messages: [result("needs attention")] }, "attention"],
      [{ session, messages: [result("needs attention")] }, "failing"],
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
      [{ session: archived, job: job() }, "missing"],
      [{ job: job() }, "missing"],
      [{ session: archived }, "available"],
      [{ session, messages: [result("on"), start] }, "starting"],
    ];
    for (const [world, status] of cases) {
      expect((await conversationsScribe(world)).status, JSON.stringify(world)).toBe(status);
    }
  });

  it("finds an automated scribe's conversation by key and others by display name", async () => {
    const review = scribeById("claim-consolidation")!,
      memory = scribeById("memory")!;
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "cron.list") {
        return {
          jobs: [
            job({ sessionTarget: "session:s-review" }),
            { id: "other", declarationKey: "something:else", enabled: true },
          ],
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
      if (method === "sessions.describe") {
        const row = { key: "s-review", displayName: scribeLabel(review) };
        return { session: params?.key === "s-review" ? row : null };
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
      ["granola", "available", undefined, undefined],
      ["memory", "done", "s-memory", undefined],
    ]);
    expect(snapshots[3]!.result).toEqual({ state: "done", summary: "Saved 4" });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      search: scribeLabel(memory),
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

  it("pairs an automated scribe with its target conversation by key, even renamed", async () => {
    const label = "Scribe · Learn from conversations";
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "cron.list") {
        const key = "knowledge:scribe:conversations";
        return {
          jobs: [
            {
              ...job({ id: "old", enabled: false }),
              declarationKey: key,
              sessionTarget: "session:s-old",
            },
            { ...job({ id: "mine" }), declarationKey: key, sessionTarget: "session:s-owner" },
          ],
        };
      }
      if (method === "sessions.list") {
        return {
          sessions: params?.search === label ? [{ key: "s-newer", displayName: label }] : [],
        };
      }
      if (method === "sessions.describe") {
        return {
          session: params?.key === "s-owner" ? { key: "s-owner", displayName: "renamed" } : null,
        };
      }
      return { messages: [] };
    });
    const snapshots = await loadScribes({ request } as never, "main");
    const conversations = snapshots.find((snapshot) => snapshot.scribe.id === "conversations")!;
    expect([conversations.session?.key, conversations.job?.id, conversations.status]).toEqual([
      "s-owner",
      "mine",
      "on",
    ]);
  });

  it("reads a fresh-session job's status from its latest run unless a later turn answered", async () => {
    const label = "Scribe · Learn from conversations";
    const load = async (conversation: unknown[]) => {
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "cron.list") {
          const current = { sessionTarget: "current", sessionKey: "s-owner" };
          return { jobs: [{ ...job(current), declarationKey: "knowledge:scribe:conversations" }] };
        }
        if (method === "sessions.describe") {
          return {
            session: params?.key === "s-owner" ? { key: "s-owner", displayName: label } : null,
          };
        }
        if (method === "sessions.list") {
          return { sessions: [] };
        }
        if (method === "cron.runs") {
          const run = { ts: 2_000, runAtMs: 1_000, runId: "r1", sessionKey: "s-run" };
          return { entries: [run] };
        }
        // The run's transcript, kept after its session is cleaned up.
        if (method === "cron.history" && params?.runId === "r1") {
          return { messages: [assistant("Scribe status: failed — store is read-only")] };
        }
        if (method === "chat.history") {
          return { messages: params?.sessionKey === "s-owner" ? conversation : [] };
        }
        throw new Error(`unexpected ${method}`);
      });
      const snapshots = await loadScribes({ request } as never, "main");
      return snapshots.find((snapshot) => snapshot.scribe.id === "conversations")!;
    };
    const setup = { ...user("Set up"), timestamp: 500 };
    const failed = await load([setup, assistant("Scribe status: on — set up")]);
    expect([failed.session?.key, failed.status, failed.result?.summary]).toEqual([
      "s-owner",
      "failing",
      "store is read-only",
    ]);
    const repair = { ...user("Repair the Knowledge scribe"), timestamp: 1_500 };
    const repaired = await load([repair, assistant("Scribe status: on — repaired")]);
    // The repair decides the state; the shown result stays the run's.
    expect([repaired.status, repaired.result?.summary]).toEqual(["on", "store is read-only"]);
  });

  it("detects conversation counts and MEMORY.md, omitting what it cannot read", async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.list") {
        return params?.archived
          ? { sessions: [], count: 1 }
          : { sessions: [], count: 1, totalCount: 148 };
      }
      if (method === "plugins.inspect") {
        return { plugin: { installed: true, enabled: true }, mcpAuth: [{ state: "authorized" }] };
      }
      return { files: [{ name: "MEMORY.md", missing: false, size: 4096 }] };
    });
    expect(await detectSources({ request } as never, "main")).toEqual({
      activeConversations: 148,
      memoryFile: { size: 4096 },
      plugins: { granola: "ready" },
    });
    const failing = vi.fn(async () => {
      throw new Error("missing scope");
    });
    expect(await detectSources({ request: failing } as never, "main")).toEqual({});
  });
});

describe("plugin readiness", () => {
  const read = async (answer: () => unknown) => {
    const request = vi.fn(async (method: string) => {
      if (method === "plugins.inspect") {
        return answer();
      }
      if (method === "sessions.list") {
        return { sessions: [], count: 0 };
      }
      if (method === "agents.files.list") {
        return { files: [] };
      }
      throw new Error(`unexpected ${method}`);
    });
    const detection = await detectSources({ request } as never, "main");
    expect(request).toHaveBeenCalledWith("plugins.inspect", {
      pluginId: scribeById("granola")!.plugin!.id,
    });
    return detection.plugins;
  };

  it("maps plugins.inspect to missing, disabled, needs sign-in and ready", async () => {
    const plugin = (installed: boolean, enabled: boolean) => ({ installed, enabled });
    expect(await read(() => ({ plugin: plugin(false, false) }))).toEqual({ granola: "missing" });
    expect(await read(() => ({ plugin: plugin(true, false) }))).toEqual({ granola: "disabled" });
    expect(
      await read(() => ({
        plugin: plugin(true, true),
        mcpAuth: [{ serverName: "granola", state: "requires-authorization" }],
      })),
    ).toEqual({ granola: "needs-sign-in" });
    expect(
      await read(() => ({
        plugin: plugin(true, true),
        mcpAuth: [{ serverName: "granola", state: "authorized" }],
      })),
    ).toEqual({ granola: "ready" });
  });

  it("reads an unknown plugin as missing and any other failure as unknown", async () => {
    expect(
      await read(() => {
        throw Object.assign(new Error('Plugin "granola" not found.'), {
          gatewayCode: "INVALID_REQUEST",
        });
      }),
    ).toEqual({ granola: "missing" });
    expect(
      await read(() => {
        throw Object.assign(new Error("missing scope"), { gatewayCode: "UNAUTHORIZED" });
      }),
    ).toBeUndefined();
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
