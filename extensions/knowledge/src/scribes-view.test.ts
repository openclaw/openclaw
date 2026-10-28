/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { Page } from "./page-context.js";
import { defaultOptions, repairPrompt, scribeSetup, setupPrompt } from "./scribes-catalog.js";
import { scribes } from "./scribes-view.js";

type Call = [string, Record<string, unknown> | undefined];
const reviewJob = {
  id: "job-review",
  declarationKey: "knowledge:scribe:claim-consolidation",
  enabled: true,
  configRevision: "rev-7",
  schedule: { kind: "cron", expr: "45 3 * * 0" },
  failureAlert: { after: 2 },
  state: { lastRunStatus: "ok", lastRunAtMs: 1_793_000_000_000, nextRunAtMs: 1_793_090_000_000 },
};

// A fake page host: Gateway reads answer from `world`; writes are recorded.
function fixture(world: {
  sessions?: Record<
    string,
    { key: string; sessionId?: string; displayName: string; archived?: boolean; status?: string }
  >;
  jobs?: unknown[];
  history?: Record<string, unknown[]>;
  runs?: unknown[];
  canWrite?: boolean;
}) {
  // HTMLDialogElement is incomplete in jsdom.
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.open = true;
    },
    close(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  const calls: Call[] = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params]);
    switch (method) {
      case "cron.list":
        return { jobs: world.jobs ?? [], hasMore: false, nextOffset: null };
      case "sessions.list": {
        if (typeof params?.search === "string") {
          const row = world.sessions?.[params.search];
          return { sessions: row ? [row] : [] };
        }
        return { sessions: [], count: 1, totalCount: params?.archived ? 1204 : 148 };
      }
      case "chat.history":
        return {
          messages:
            typeof params?.sessionKey === "string"
              ? (world.history?.[params.sessionKey] ?? [])
              : [],
        };
      case "cron.runs":
        return {
          entries: world.runs ?? [
            {
              ts: 1_793_000_000_000,
              status: "ok",
              summary: "Filed claims.\nScribe status: on — 9 filed · 2 pages created",
              model: "anthropic/claude",
            },
          ],
        };
      case "agents.files.list":
        return { files: [{ name: "MEMORY.md", missing: false, size: 8192 }] };
      case "cron.run":
        return { ok: true, enqueued: true, runId: "run-1" };
      default:
        return { ok: true };
    }
  });
  const create = vi.fn(async () => "agent:main:dock:new");
  const open = vi.fn();
  const connection = { connected: true, canRead: true, canWrite: world.canWrite ?? true };
  const host = { request, connection, sessions: { create, open } };
  const load = vi.fn(async () => true);
  const scribesTab = document.createElement("button");
  const ui = {
    s: { context: { host }, scribe: "", storesSnapshot: undefined },
    live: () => true,
    viewedAgent: () => "main",
    displayName: (id: string) => (id === "main" ? "Main" : id),
    announce: vi.fn(),
    errorText: (error: unknown) => String(error),
    load,
    scribesTab,
  } as unknown as Page;
  const page = document.createElement("section");
  page.className = "knowledge-page";
  document.body.append(page);
  const render = async () => {
    const target = document.createElement("div");
    await scribes(ui, 1, target);
    page.replaceChildren(target);
    return target;
  };
  return { ui, calls, request, create, open, load, render, page, scribesTab };
}
const reviewSetup = scribeSetup(
  "claim-consolidation",
  "ongoing",
  { schedule: "45 3 * * 0" },
  "America/Los_Angeles",
);
const reviewSession = {
  "Scribe · Knowledge Consolidation": {
    key: "s-review",
    displayName: "Scribe · Knowledge Consolidation",
  },
};
const buttonNamed = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === text)!;
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

afterEach(() => document.body.replaceChildren());

it("lists On and Available scribes with honest detection and a tab count", async () => {
  const { render, scribesTab } = fixture({
    sessions: reviewSession,
    jobs: [reviewJob],
  });
  const view = await render();
  expect([...view.querySelectorAll(".knowledge-eyebrow")].map((n) => n.textContent)).toEqual([
    "On · 1",
    "Available · 2",
  ]);
  expect(view.textContent).toContain("148 active · 1,204 archived conversations on Main");
  expect(view.textContent).toContain("Found Memory on Main · MEMORY.md 8 KB");
  expect(view.querySelector(".scribe-chip-on")?.textContent).toBe("On");
  expect(scribesTab.textContent).toBe("Scribes1");
});

it("starts a conversations scribe: creates its titled conversation and sends the prompt shown", async () => {
  const { render, create, calls, ui, load, page } = fixture({});
  const view = await render();
  buttonNamed(view, "Set up…").click();
  const dialog = page.querySelector("dialog")!;
  expect(dialog.textContent).toContain("148 conversations in your sidebar.");
  (dialog.querySelector("#scribe-often-once") as HTMLInputElement).click();
  (dialog.querySelector("#scribe-which-all") as HTMLInputElement).click();
  const select = dialog.querySelector("select")!;
  select.value = "90d";
  select.dispatchEvent(new Event("change"));
  expect(dialog.textContent).toContain("Nothing is scheduled.");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const expected = setupPrompt(
    scribeSetup("conversations", "once", { scope: "all", since: "90d" }, timezone),
  );
  expect(dialog.querySelector(".scribe-prompt summary")?.textContent).toBe("Prompt");
  expect(dialog.querySelector("textarea")!.value).toBe(expected);
  expect(dialog.textContent).toContain("Generated from your choices.");
  buttonNamed(dialog, "Start").click();
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  expect(create).toHaveBeenCalledWith({
    agentId: "main",
    displayName: "Scribe · Learn from conversations",
    surface: "plugin-dock",
  });
  const send = calls.find(([method]) => method === "chat.send")![1]!;
  expect(send).toEqual({
    sessionKey: "agent:main:dock:new",
    agentId: "main",
    message: expected,
    idempotencyKey: expect.stringMatching(
      /^knowledge:scribe:conversations:agent:main:dock:new:[0-9a-f-]{36}$/,
    ),
  });
  expect(ui.s.scribe).toBe("conversations");
  expect(page.querySelector("dialog")).toBeNull();
});

it.each([
  ["weekly by default", undefined, "45 3 * * 0"],
  ["nightly when chosen", "#scribe-review-nightly", "45 3 * * *"],
] as const)("starts the review scribe %s", async (_name, pick, schedule) => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { render, calls, page } = fixture({});
  const view = await render();
  buttonNamed(view, "Turn on…").click();
  const dialog = page.querySelector("dialog")!;
  expect(dialog.querySelector("legend")?.textContent).toBe("How often");
  expect((dialog.querySelector("#scribe-review-weekly") as HTMLInputElement).checked).toBe(true);
  expect(dialog.textContent).toContain("Sundays at 3:45 AM.");
  expect(dialog.textContent).toContain("Each run is an agent turn over every unlinked claim");
  if (pick) {
    (dialog.querySelector(pick) as HTMLInputElement).click();
  }
  buttonNamed(dialog, "Turn on").click();
  await vi.waitFor(() => expect(calls.some(([method]) => method === "chat.send")).toBe(true));
  const send = calls.find(([method]) => method === "chat.send")![1]!;
  expect(send.message).toBe(
    setupPrompt(scribeSetup("claim-consolidation", "ongoing", { schedule }, timezone)),
  );
  expect(String(send.message)).toContain(`(cron \`${schedule}\`)`);
});

it("sends a hand-edited prompt and stops regenerating it until asked", async () => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { render, calls, page } = fixture({});
  const view = await render();
  buttonNamed(view, "Turn on…").click();
  const dialog = page.querySelector("dialog")!;
  const text = dialog.querySelector("textarea")!;
  const edited = text.value.replace("cron `45 3 * * 0`", "cron `15 2 * * 1`");
  text.value = edited;
  text.dispatchEvent(new Event("input"));
  expect(dialog.textContent).toContain("Edited by hand.");
  (dialog.querySelector("#scribe-review-nightly") as HTMLInputElement).click();
  expect(text.value, "a choice no longer overwrites the edit").toBe(edited);
  buttonNamed(dialog, "Use generated prompt").click();
  expect(text.value).toBe(
    setupPrompt(
      scribeSetup("claim-consolidation", "ongoing", { schedule: "45 3 * * *" }, timezone),
    ),
  );
  text.value = "  ";
  text.dispatchEvent(new Event("input"));
  expect(buttonNamed(dialog, "Turn on").disabled, "an empty prompt can't start").toBe(true);
  text.value = edited;
  text.dispatchEvent(new Event("input"));
  buttonNamed(dialog, "Turn on").click();
  await vi.waitFor(() => expect(calls.some(([method]) => method === "chat.send")).toBe(true));
  expect(calls.find(([method]) => method === "chat.send")![1]!.message).toBe(edited);
});

it("restarts a turned-off scribe in its existing conversation with a fresh attempt key", async () => {
  const label = "Scribe · Learn from conversations";
  const { render, create, calls, page } = fixture({
    sessions: { [label]: { key: "s-conv", displayName: label } },
    history: {
      "s-conv": [
        {
          role: "assistant",
          content: "Scribe status: on — On",
        },
      ],
    },
  });
  const view = await render();
  buttonNamed(view, "Set up…").click();
  buttonNamed(page.querySelector("dialog")!, "Start").click();
  await vi.waitFor(() => expect(calls.some(([method]) => method === "chat.send")).toBe(true));
  expect(create).not.toHaveBeenCalled();
  const send = calls.find(([method]) => method === "chat.send")![1]!;
  expect(send.sessionKey).toBe("s-conv");
  expect(String(send.idempotencyKey)).toMatch(
    /^knowledge:scribe:conversations:s-conv:[0-9a-f-]{36}$/,
  );
});

it("keeps the start dialog open with the error when the Gateway rejects the start", async () => {
  const { render, request, page } = fixture({});
  const view = await render();
  request.mockImplementationOnce(async () => {
    throw new Error("missing scope: operator.write");
  });
  buttonNamed(view, "Import…").click();
  const dialog = page.querySelector("dialog")!;
  expect(dialog.textContent).toContain("8 KB in Main’s workspace.");
  buttonNamed(dialog, "Start import").click();
  await vi.waitFor(() =>
    expect(dialog.querySelector(".knowledge-error")?.textContent).toContain("missing scope"),
  );
  expect(dialog.open).toBe(true);
});

it("retries a failed setup send in the conversation it already created", async () => {
  const { render, request, create, calls, page } = fixture({});
  const view = await render();
  buttonNamed(view, "Turn on…").click();
  const dialog = page.querySelector("dialog")!;
  request.mockImplementationOnce(async () => {
    throw new Error("Gateway restarting");
  });
  buttonNamed(dialog, "Turn on").click();
  await vi.waitFor(() =>
    expect(dialog.querySelector(".knowledge-error")?.textContent).toContain("Gateway restarting"),
  );
  buttonNamed(dialog, "Turn on").click();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  expect(create).toHaveBeenCalledTimes(1);
  // The rejected first send bypasses the recorder; the retry is the one recorded send.
  const sends = calls.filter(([method]) => method === "chat.send");
  expect(sends.map(([, params]) => params?.sessionKey)).toEqual(["agent:main:dock:new"]);
});

it("keeps one idempotency key per dialog and gives each dialog its own", async () => {
  const { render, request, calls, page } = fixture({});
  const view = await render();
  const sendKeys = () =>
    calls.filter(([method]) => method === "chat.send").map(([, params]) => params?.idempotencyKey);
  buttonNamed(view, "Set up…").click();
  const first = page.querySelector("dialog")!;
  // The first send is rejected after it reaches the Gateway; the retry must reuse its key.
  request.mockImplementationOnce(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params]);
    throw new Error("Gateway restarting");
  });
  buttonNamed(first, "Start").click();
  await vi.waitFor(() => expect(first.querySelector(".knowledge-error")).not.toBeNull());
  buttonNamed(first, "Start").click();
  await vi.waitFor(() => expect(first.open).toBe(false));
  buttonNamed(view, "Set up…").click();
  buttonNamed(page.querySelector("dialog")!, "Start").click();
  await vi.waitFor(() => expect(sendKeys()).toHaveLength(3));
  const [failed, retried, again] = sendKeys();
  expect(retried).toBe(failed);
  expect(again).not.toBe(failed);
  expect(String(again)).toMatch(
    /^knowledge:scribe:conversations:agent:main:dock:new:[0-9a-f-]{36}$/,
  );
});

it("disables starting without write access", async () => {
  const { render, page } = fixture({ canWrite: false });
  const view = await render();
  const setUp = buttonNamed(view, "Set up…");
  expect(setUp.disabled).toBe(true);
  setUp.disabled = false;
  setUp.click();
  const dialog = page.querySelector("dialog")!;
  expect(buttonNamed(dialog, "Start").disabled).toBe(true);
  expect(dialog.textContent).toContain("needs write access");
});

it("runs, pauses, turns off and opens an On scribe from its detail", async () => {
  const { render, ui, calls, open, load, page } = fixture({
    sessions: reviewSession,
    jobs: [reviewJob],
  });
  ui.s.scribe = "claim-consolidation";
  const view = await render();
  expect(view.textContent).toContain("1 recent run, all succeeded");
  expect(view.querySelector(".scribe-run span")?.textContent).toBe("9 filed · 2 pages created");
  expect(view.textContent).toContain("Alert after 2 failed runs");
  expect(view.textContent).toMatch(/Weekly on Sunday, 3:45\sAM/);
  buttonNamed(view, "Run now").click();
  await flush();
  expect(calls.at(-1)).toEqual(["cron.run", { id: "job-review", mode: "force" }]);
  buttonNamed(view, "Pause").click();
  await flush();
  expect(calls.at(-1)).toEqual([
    "cron.update",
    { id: "job-review", patch: { enabled: false }, expectedConfigRevision: "rev-7" },
  ]);
  buttonNamed(view, "Open conversation").click();
  expect(open).toHaveBeenCalledWith({ sessionKey: "s-review", agentId: "main" });
  buttonNamed(view, "Turn off…").click();
  const confirm = page.querySelector("dialog")!;
  buttonNamed(confirm, "Turn off").click();
  await vi.waitFor(() =>
    expect(calls.at(-1)).toEqual([
      "cron.remove",
      { id: "job-review", expectedConfigRevision: "rev-7" },
    ]),
  );
  expect(load).toHaveBeenCalled();
});

it("reports a skipped run that could not complete as failed", async () => {
  const { render, ui } = fixture({
    sessions: reviewSession,
    jobs: [reviewJob],
    runs: [
      {
        ts: 1_793_000_000_000,
        status: "skipped",
        completionStatus: "failed",
        error: "agent tool caller authority is no longer active",
      },
    ],
  });
  ui.s.scribe = "claim-consolidation";
  const view = await render();
  expect(view.textContent).toContain("1 of 1 recent run failed");
  expect(view.querySelector(".scribe-run")?.textContent).toContain(
    "agent tool caller authority is no longer active",
  );
  expect(view.querySelector(".scribe-run .scribe-chip-warn")?.textContent).toBe("Failing");
});

it("repairs a scribe whose conversation was archived, keeping its run message", async () => {
  const { render, ui, calls } = fixture({
    sessions: {
      "Scribe · Knowledge Consolidation": {
        key: "s-review",
        sessionId: "sid-review",
        displayName: "Scribe · Knowledge Consolidation",
        archived: true,
      },
    },
    jobs: [{ ...reviewJob, payload: { kind: "agentTurn", message: "Edited run message" } }],
  });
  ui.s.scribe = "claim-consolidation";
  const view = await render();
  expect(view.querySelector(".scribe-chip-warn")?.textContent).toBe("Needs reauthorization");
  expect(buttonNamed(view, "Run now")).toBeUndefined();
  buttonNamed(view, "Repair").click();
  await vi.waitFor(() => expect(calls.at(-1)?.[0]).toBe("chat.send"));
  expect(calls.at(-2)).toEqual([
    "sessions.patch",
    { key: "s-review", agentId: "main", archived: false, expectedSessionId: "sid-review" },
  ]);
  const send = calls.at(-1)![1]!;
  expect(send.message).toBe(
    repairPrompt("claim-consolidation", {
      schedule: reviewJob.schedule,
      runMessage: "Edited run message",
    }),
  );
  expect(String(send.idempotencyKey)).toMatch(/^knowledge:scribe:claim-consolidation:repair:/);
});

const userText = (content: string) => ({ role: "user", content });
const statusLine = (state: string, summary: string) => ({
  role: "assistant",
  content: `Done.\nScribe status: ${state} — ${summary}`,
});

it("forces an ongoing scribe's first run once after its setup turn reports on", async () => {
  const label = "Scribe · Learn from conversations";
  const setup = scribeSetup(
    "conversations",
    "ongoing",
    { scope: "active", since: "30d", schedule: "0 4 * * *" },
    "America/Los_Angeles",
  );
  const job = {
    id: "job-first",
    declarationKey: "knowledge:scribe:conversations",
    enabled: true,
    schedule: { kind: "cron", expr: "0 4 * * *" },
    state: { nextRunAtMs: 1_793_090_000_000 },
  };
  const { render, ui, calls } = fixture({
    sessions: { [label]: { key: "s-conv", displayName: label } },
    jobs: [job],
    history: {
      "s-conv": [userText(setupPrompt(setup)), statusLine("on", "Scheduled daily at 4:00")],
    },
    runs: [],
  });
  ui.s.scribe = "conversations";
  const view = await render();
  const forced = () => calls.filter(([method]) => method === "cron.run");
  expect(forced()).toEqual([["cron.run", { id: "job-first", mode: "force" }]]);
  expect(view.querySelector(".scribe-run")?.textContent).toContain("First runRunning now");
  await render();
  expect(forced()).toHaveLength(1);
});

it("tries the first run again on the next load when forcing it failed", async () => {
  const setup = reviewSetup;
  const { render, ui, calls, request } = fixture({
    sessions: reviewSession,
    jobs: [{ ...reviewJob, id: "job-retry-first", state: {} }],
    history: {
      "s-review": [userText(setupPrompt(setup)), statusLine("on", "On")],
    },
    runs: [],
  });
  ui.s.scribe = "claim-consolidation";
  // The first cron.run answers without admitting a run, the second is rejected, the third runs.
  const answer = request.getMockImplementation()!;
  let attempts = 0;
  request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    if (method === "cron.run" && attempts < 2) {
      calls.push([method, params]);
      if (attempts++ === 0) {
        return { ok: true, ran: false, reason: "stopped" };
      }
      throw new Error("Gateway restarting");
    }
    return answer(method, params);
  });
  const view = await render();
  expect(view.textContent).toMatch(/ScheduleWeekly on Sunday, 3:45\sAM/);
  expect(view.textContent).not.toContain("First run");
  expect(ui.announce).toHaveBeenCalledWith(
    expect.stringContaining(
      "the first run did not start. Error: The run did not start: the scheduler is stopped.",
    ),
  );
  expect((await render()).textContent).not.toContain("First run");
  const later = await render();
  const force = ["cron.run", { id: "job-retry-first", mode: "force" }];
  expect(calls.filter(([method]) => method === "cron.run")).toEqual([force, force, force]);
  expect(later.querySelector(".scribe-run")?.textContent).toContain("First runRunning now");
});

it("does not force a run after a repair, or for a job that already ran", async () => {
  const setup = reviewSetup;
  const fresh = { ...reviewJob, id: "job-repaired", state: {} };
  const { render, calls } = fixture({
    sessions: reviewSession,
    jobs: [fresh],
    history: {
      "s-review": [
        userText(repairPrompt("claim-consolidation", { schedule: reviewJob.schedule })),
        statusLine("on", "Recreated"),
      ],
    },
  });
  await render();
  expect(calls.some(([method]) => method === "cron.run")).toBe(false);
  const ran = fixture({
    sessions: reviewSession,
    jobs: [reviewJob],
    history: {
      "s-review": [userText(setupPrompt(setup)), statusLine("on", "On")],
    },
  });
  await ran.render();
  expect(ran.calls.some(([method]) => method === "cron.run")).toBe(false);
});

it("starts a failed one-time scribe again from the start dialog with a new attempt", async () => {
  const label = "Scribe · Learn from Memory";
  const setup = scribeSetup(
    "memory",
    "once",
    { sources: ["memory-md", "dreams"] },
    "America/Los_Angeles",
  );
  const { render, ui, calls, create, page } = fixture({
    sessions: { [label]: { key: "s-mem", displayName: label } },
    history: {
      "s-mem": [userText(setupPrompt(setup)), statusLine("failed", "Store was not writable")],
    },
  });
  ui.s.scribe = "memory";
  const view = await render();
  expect(view.querySelector(".scribe-chip-warn")?.textContent).toBe("Failing");
  expect(buttonNamed(view, "Repair")).toBeUndefined();
  buttonNamed(view, "Start again…").click();
  buttonNamed(page.querySelector("dialog")!, "Start import").click();
  await vi.waitFor(() => expect(calls.at(-1)?.[0]).toBe("chat.send"));
  expect(create).not.toHaveBeenCalled();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(calls.at(-1)![1]).toEqual({
    sessionKey: "s-mem",
    agentId: "main",
    message: setupPrompt(scribeSetup("memory", "once", defaultOptions("memory"), timezone)),
    idempotencyKey: expect.stringMatching(/^knowledge:scribe:memory:s-mem:[0-9a-f-]{36}$/),
  });
});

it("recovers a conversation whose setup never arrived or whose setup turn stopped", async () => {
  const memoryLabel = "Scribe · Learn from Memory";
  const reviewLabel = "Scribe · Knowledge Consolidation";
  const setup = scribeSetup("memory", "once", { sources: ["memory-md"] }, "UTC");
  const { render, ui, calls, create, page } = fixture({
    sessions: {
      [reviewLabel]: { key: "s-review-empty", displayName: reviewLabel },
      [memoryLabel]: { key: "s-mem-stopped", displayName: memoryLabel, status: "interrupted" },
    },
    history: { "s-mem-stopped": [userText(setupPrompt(setup))] },
  });
  const view = await render();
  // The review conversation never got its setup: it is startable again, in the same conversation.
  buttonNamed(view, "Turn on…").click();
  buttonNamed(page.querySelector("dialog")!, "Turn on").click();
  await vi.waitFor(() => expect(calls.at(-1)?.[0]).toBe("chat.send"));
  expect(create).not.toHaveBeenCalled();
  expect(calls.at(-1)![1]!.sessionKey).toBe("s-review-empty");
  // The memory start turn stopped without an answer: it shows Failing and can start again.
  ui.s.scribe = "memory";
  const detail = await render();
  expect(detail.querySelector(".scribe-chip-warn")?.textContent).toBe("Failing");
  expect(buttonNamed(detail, "Repair")).toBeUndefined();
  buttonNamed(detail, "Start again…").click();
  buttonNamed(page.querySelector("dialog")!, "Start import").click();
  await vi.waitFor(() => expect(calls.at(-1)![1]!.sessionKey).toBe("s-mem-stopped"));
});

it("shows a Run now the scheduler refused instead of reporting it running", async () => {
  const { render, ui, request, load } = fixture({
    sessions: reviewSession,
    jobs: [reviewJob],
  });
  ui.s.scribe = "claim-consolidation";
  const view = await render();
  const answer = request.getMockImplementation()!;
  request.mockImplementation(async (method: string, params?: Record<string, unknown>) =>
    method === "cron.run" ? { ok: true, ran: false, reason: "ownerless" } : answer(method, params),
  );
  buttonNamed(view, "Run now").click();
  await vi.waitFor(() =>
    expect(view.querySelector(".knowledge-error")?.textContent).toContain(
      "the automation lost its owner",
    ),
  );
  expect(ui.announce).not.toHaveBeenCalledWith("Knowledge Consolidation is running.");
  expect(load).not.toHaveBeenCalled();
});
