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
  sessionTarget: "session:s-review",
  schedule: { kind: "cron", expr: "45 3 * * 0" },
  failureAlert: { after: 2 },
  state: { lastRunStatus: "ok", lastRunAtMs: 1_793_000_000_000, nextRunAtMs: 1_793_090_000_000 },
};

let gateways = 0;
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
  /** plugins.inspect answer for the Granola plugin; absent reads as not installed. */
  granola?: { installed: boolean; enabled: boolean; authorized?: boolean };
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
      case "sessions.describe":
        return {
          session:
            Object.values(world.sessions ?? {}).find((row) => row.key === params?.key) ?? null,
        };
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
      case "plugins.inspect": {
        const plugin = world.granola ?? { installed: false, enabled: false };
        return {
          plugin,
          ...(plugin.installed && plugin.enabled
            ? {
                mcpAuth: [
                  {
                    serverName: "granola",
                    state: plugin.authorized ? "authorized" : "requires-authorization",
                  },
                ],
              }
            : {}),
        };
      }
      default:
        return { ok: true };
    }
  });
  const create = vi.fn(async () => "agent:main:dock:new");
  const open = vi.fn();
  const connection = { connected: true, canRead: true, canWrite: world.canWrite ?? true };
  // Gateway events the page listens to, by name.
  const events = new Map<string, () => void>();
  const onEvent = vi.fn((name: string, listener: () => void) => {
    events.set(name, listener);
    return () => events.delete(name);
  });
  // Update state is kept per Gateway, by base path: each fixture is its own Gateway.
  const basePath = `/gateway-${++gateways}`;
  const host = { request, connection, sessions: { create, open }, basePath, onEvent };
  const load = vi.fn(async () => true);
  const scribesTab = document.createElement("button");
  const ui = {
    s: { context: { host }, scribe: "", storesSnapshot: undefined, tab: "scribes" },
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
  return { ui, calls, request, create, open, load, render, page, scribesTab, events };
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
    "Available · 3",
  ]);
  expect(view.textContent).toContain("148 active · 1,204 archived conversations on Main");
  expect(view.textContent).toContain("Found Memory on Main · MEMORY.md 8 KB");
  expect(view.querySelector(".scribe-chip-on")?.textContent).toBe("On");
  expect(scribesTab.textContent).toBe("Scribes1");
});

it("asks for the Granola plugin before the Granola scribe can start", async () => {
  const { render } = fixture({});
  const view = await render();
  const row = buttonNamed(view, "Install Granola…").closest(".scribe-row")!;
  expect(row.textContent).toContain("Needs the Granola plugin, which is not installed");
  expect(buttonNamed(row, "Set up…").disabled).toBe(true);

  const signIn = await fixture({ granola: { installed: true, enabled: true } }).render();
  const signInRow = buttonNamed(signIn, "Connect Granola…").closest(".scribe-row")!;
  expect(signInRow.textContent).toContain("not connected to your Granola account");
  expect(buttonNamed(signInRow, "Set up…").disabled).toBe(true);
});

it("starts the Granola scribe once the plugin is connected", async () => {
  const { render, page, calls, load } = fixture({
    granola: { installed: true, enabled: true, authorized: true },
  });
  const view = await render();
  const row = [...view.querySelectorAll(".scribe-row")].find((node) =>
    node.textContent?.includes("Learn from Granola"),
  )!;
  expect(row.textContent).toContain("Granola connected");
  const setUp = buttonNamed(row, "Set up…");
  expect(setUp.disabled).toBe(false);
  setUp.click();
  const dialog = page.querySelector("dialog")!;
  expect(dialog.textContent).toContain(
    "Granola connected. This scribe reads through the Granola plugin.",
  );
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(dialog.querySelector("textarea")!.value).toBe(
    setupPrompt(scribeSetup("granola", "ongoing", defaultOptions("granola"), timezone)),
  );
  buttonNamed(dialog, "Start").click();
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  expect(calls.find(([method]) => method === "chat.send")![1]!.message).toContain(
    'Follow "Learn from Granola"',
  );
});

it("shows an On Granola scribe's weekday schedule and a disconnected plugin in its detail", async () => {
  const { render, ui } = fixture({
    sessions: {
      "Scribe · Learn from Granola": {
        key: "s-granola",
        displayName: "Scribe · Learn from Granola",
      },
    },
    jobs: [
      {
        ...reviewJob,
        id: "job-granola",
        declarationKey: "knowledge:scribe:granola",
        sessionTarget: "session:s-granola",
        schedule: { kind: "cron", expr: "0 10,14,18 * * 1-5" },
      },
    ],
    granola: { installed: true, enabled: true },
  });
  ui.s.scribe = "granola";
  const view = await render();
  expect(view.textContent).toMatch(/ScheduleWeekdays, 10:00\sAM, 2:00\sPM and 6:00\sPM/);
  expect(view.textContent).toContain(
    "SourceGranola plugin installed, not connected to your Granola account",
  );
  expect(buttonNamed(view, "Connect Granola…")).toBeTruthy();
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

it("asks an earlier scribe's conversation to update it once and offers an edited one the current message", async () => {
  const runMessage = setupPrompt(reviewSetup).match(/```text\n([\s\S]+)\n```$/)![1]!;
  // The claims-only consolidation message an earlier version generated.
  const earlier = runMessage
    .replace(
      /Follow every step of [^\n]+ even when no claim is left to link\./,
      'Follow the "Scribe runs" section of the knowledge-claim-consolidation skill: consolidate every claim that names no page until none is left to decide.',
    )
    .replace("; Timelines retired and left; pages reviewed, changed and left unchanged", "");
  const legacy = { ...reviewJob, sessionKey: "s-review", payload: { kind: "agentTurn" } };
  const legacyJob = {
    ...legacy,
    payload: { kind: "agentTurn", message: earlier, thinking: "high", toolsAllow: ["read"] },
    idleOnly: true,
  };
  const unedited = fixture({ sessions: reviewSession, jobs: [legacyJob] });
  // A send that fails is asked again on the next load.
  const answer = unedited.request.getMockImplementation()!;
  let failed = false;
  unedited.request.mockImplementation(async (method, params) => {
    if (method === "chat.send" && !failed) {
      failed = true;
      throw new Error("offline");
    }
    return answer(method, params);
  });
  await unedited.render();
  expect(unedited.ui.announce).toHaveBeenCalledWith(
    expect.stringContaining("the update was not sent"),
  );
  await unedited.render();
  await unedited.render();
  // The turn's first write (the target) is not the whole update: still updating, not asked again.
  Object.assign(legacyJob, { configRevision: "rev-8", sessionTarget: "current" });
  expect((await unedited.render()).querySelector(".scribe-row")?.textContent).toContain(
    "Updating…",
  );
  const sent = unedited.calls.filter(([method]) => method === "chat.send");
  // A turn in the conversation re-declares the automation; the page never edits it directly.
  expect(unedited.calls.some(([method]) => method === "cron.update")).toBe(false);
  expect(sent).toHaveLength(1);
  expect(sent[0]![1]).toMatchObject({
    sessionKey: "s-review",
    idempotencyKey: expect.stringMatching(
      /^knowledge:scribe:claim-consolidation:update:job-review:rev-7:[0-9a-f-]{36}$/,
    ),
  });
  const prompt = String(sent[0]![1]!.message);
  expect(prompt).toMatch(/^Update the Knowledge scribe "Knowledge Consolidation"/);
  expect(prompt).toContain(
    'exactly as written: `{"thinking":"high","toolsAllow":["read"],"idleOnly":true,"failureAlert":{"after":2}}`. Pass `toolsAllowMode: "exact"`',
  );
  expect(prompt).toContain("- delivery and failure alert: as saved on the current automation");
  expect(prompt).toContain("Leave `enabled` out");
  expect(prompt.endsWith(`\`\`\`text\n${runMessage}\n\`\`\``)).toBe(true);
  Object.assign(legacyJob, {
    configRevision: "rev-9",
    payload: { kind: "agentTurn", message: runMessage },
  });
  expect((await unedited.render()).querySelector(".scribe-row")?.textContent).not.toContain(
    "Updating…",
  );
  expect(unedited.ui.announce).toHaveBeenCalledWith("Knowledge Consolidation: updated.");
  unedited.page.remove();

  const differing = `${earlier}\nAlso tidy page titles.`;
  const job = {
    ...legacy,
    sessionTarget: "current",
    payload: { kind: "agentTurn", message: differing },
  };
  const { render, ui, calls, page, events, request } = fixture({
    sessions: reviewSession,
    jobs: [job],
    runs: [{ ts: 1_793_000_000_000, status: "ok", runId: "r1", sessionKey: "s-run" }],
  });
  const row = (await render()).querySelector(".scribe-row")?.textContent;
  expect(row).toContain("New run instructions");
  expect(calls.some(([method]) => method === "chat.send")).toBe(false);
  ui.s.scribe = "claim-consolidation";
  let view = await render();
  expect(view.querySelector(".scribe-update")?.textContent).toContain(
    "differs from what this version of Knowledge generates",
  );
  expect(buttonNamed(view, "Open run")).toBeTruthy();
  buttonNamed(view, "Replace with new…").click();
  const confirm = page.querySelector("dialog")!;
  // Only the changed lines: the claims-only step and counts out, the five-step ones in.
  const changed = [...confirm.querySelectorAll("pre del, pre ins")].map((line) => line.textContent);
  expect(changed).toEqual([
    expect.stringMatching(/^− 2\. Follow the "Scribe runs"/),
    expect.stringMatching(/^− 3\. End your reply .*withdrawn and left>`\.\n$/),
    expect.stringMatching(/^\+ 2\. Follow every step/),
    expect.stringMatching(/^\+ 3\. End your reply .*left unchanged>`\.\n$/),
    "− Also tidy page titles.\n",
  ]);
  // A lost response: confirming again repeats the same request, not a second turn.
  const answerReplace = request.getMockImplementation()!;
  let lost = false;
  request.mockImplementation(async (method, params) => {
    const result = await answerReplace(method, params);
    if (method === "chat.send" && !lost) {
      lost = true;
      throw new Error("connection lost");
    }
    return result;
  });
  buttonNamed(confirm, "Replace with new").click();
  await vi.waitFor(() => expect(lost).toBe(true));
  await vi.waitFor(() =>
    expect(buttonNamed(confirm, "Replace with new").hasAttribute("disabled")).toBe(false),
  );
  buttonNamed(confirm, "Replace with new").click();
  await vi.waitFor(() =>
    expect(calls.filter(([method]) => method === "chat.send")).toHaveLength(2),
  );
  const [first, second] = calls.filter(([method]) => method === "chat.send");
  expect(second![1]!.idempotencyKey).toBe(first![1]!.idempotencyKey);
  expect(String(calls.at(-1)![1]!.message).endsWith(`\`\`\`text\n${runMessage}\n\`\`\``)).toBe(
    true,
  );
  // A late replacement is a new attempt, but losing its response keeps that attempt's key.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4 * 60_000);
  try {
    lost = false;
    buttonNamed(await render(), "Try again").click();
    await vi.waitFor(() =>
      expect(ui.announce).toHaveBeenCalledWith(expect.stringContaining("connection lost")),
    );
    buttonNamed(await render(), "Try again").click();
    await vi.waitFor(() =>
      expect(calls.filter(([method]) => method === "chat.send")).toHaveLength(4),
    );
    const sends = calls.filter(([method]) => method === "chat.send");
    expect(sends[2]![1]!.idempotencyKey).not.toBe(first![1]!.idempotencyKey);
    expect(sends[3]![1]!.idempotencyKey).toBe(sends[2]![1]!.idempotencyKey);
  } finally {
    vi.restoreAllMocks();
  }
  // Updating until the automation's revision changes, which a cron change reloads to show.
  view = await render();
  expect(view.querySelector(".scribe-update")?.textContent).toMatch(/^Updating Knowledge/);
  expect(events.has("cron.inventory.changed")).toBe(true);
  // Another agent's read leaves this pending update alone.
  ui.viewedAgent = () => "other";
  await render();
  ui.viewedAgent = () => "main";
  expect((await render()).querySelector(".scribe-update")?.textContent).toMatch(/^Updating/);
  // A closed page stops watching at its next tick.
  ui.s.disposed = true;
  events.get("cron.inventory.changed")!();
  expect(events.has("cron.inventory.changed")).toBe(false);
  ui.s.disposed = false;
  Object.assign(job, {
    configRevision: "rev-8",
    payload: { kind: "agentTurn", message: runMessage },
  });
  view = await render();
  expect(view.querySelector(".scribe-update")).toBeNull();
  expect(ui.announce).toHaveBeenCalledWith("Knowledge Consolidation: updated.");
  expect(events.has("cron.inventory.changed")).toBe(false);
});

it("says so when an update leaves the automation unchanged past the wait", async () => {
  // A failing scribe offers Repair; its turn is watched like an update.
  const failing = { ...reviewJob, state: { ...reviewJob.state, consecutiveErrors: 1 } };
  const { render, ui, calls } = fixture({ sessions: reviewSession, jobs: [failing] });
  ui.s.scribe = "claim-consolidation";
  buttonNamed(await render(), "Repair").click();
  await vi.waitFor(() => expect(calls.at(-1)?.[0]).toBe("chat.send"));
  expect((await render()).querySelector(".scribe-update")?.textContent).toMatch(/^Updating/);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4 * 60_000);
  try {
    expect((await render()).querySelector(".scribe-update")?.textContent).toContain(
      "hasn't changed after 3 minutes",
    );
  } finally {
    vi.restoreAllMocks();
  }
});

it("offers Try again, as a new request, when an update left the automation unchanged", async () => {
  const runMessage = setupPrompt(reviewSetup).match(/```text\n([\s\S]+)\n```$/)![1]!;
  const legacy = {
    ...reviewJob,
    id: "job-retry",
    sessionKey: "s-review",
    payload: { kind: "agentTurn", message: runMessage },
  };
  const { render, ui, calls, request } = fixture({ sessions: reviewSession, jobs: [legacy] });
  ui.s.scribe = "claim-consolidation";
  const sends = () => calls.filter(([method]) => method === "chat.send").map(([, p]) => p);
  await render();
  await render();
  expect(sends()).toHaveLength(1);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4 * 60_000);
  try {
    const view = await render();
    expect(sends()).toHaveLength(1);
    // A Try again whose send fails stays late, with the error, and can be tried again.
    const answer = request.getMockImplementation()!;
    request.mockImplementationOnce(async (method, params) => {
      const result = await answer(method, params);
      if (method === "chat.send") {
        throw new Error("offline");
      }
      return result;
    });
    const failing = view.querySelector(".scribe-update")!;
    buttonNamed(view, "Try again").click();
    await vi.waitFor(() =>
      expect(ui.announce).toHaveBeenCalledWith(expect.stringContaining("Error: offline")),
    );
    expect(failing.textContent).toContain("hasn't changed");
    // The lost send dropped the connection: the page reloads with a new host for that Gateway.
    Object.assign(ui.s.context, { host: { ...ui.s.context.host } });
    expect((await render()).querySelector(".scribe-update")?.textContent).toContain(
      "hasn't changed",
    );
    expect(sends()).toHaveLength(2);
    buttonNamed(await render(), "Try again").click();
    await vi.waitFor(() => expect(sends()).toHaveLength(3));
    // A new attempt for the completed turn, retained when that attempt loses its response.
    expect(sends()[1]!.idempotencyKey).not.toBe(sends()[0]!.idempotencyKey);
    expect(sends()[2]!.idempotencyKey).toBe(sends()[1]!.idempotencyKey);
    expect((await render()).querySelector(".scribe-update")?.textContent).toMatch(/^Updating/);
  } finally {
    vi.restoreAllMocks();
  }
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

it.each([
  ["Repair", true],
  ["Try again", true],
  ["Repair", false],
  ["Try again", false],
] as const)(
  "reuses a lost %s request after reconnecting (existing conversation: %s)",
  async (action, existing) => {
    const failing = { ...reviewJob, state: { ...reviewJob.state, consecutiveErrors: 1 } };
    const { render, ui, calls, request, create, events } = fixture({
      sessions: existing ? reviewSession : {},
      jobs: [failing],
    });
    create.mockImplementation(async () => `agent:main:repair:${create.mock.calls.length}`);
    ui.s.scribe = "claim-consolidation";
    const answer = request.getMockImplementation()!;
    const sends = () => calls.filter(([method]) => method === "chat.send").map(([, p]) => p!);
    let loseResponse = false;
    request.mockImplementation(async (method, params) => {
      const result = await answer(method, params);
      if (method === "chat.send" && loseResponse) {
        loseResponse = false;
        throw new Error("response lost after acceptance");
      }
      return result;
    });
    let view = await render();
    try {
      if (action === "Try again") {
        buttonNamed(view, "Repair").click();
        await vi.waitFor(() => expect(sends()).toHaveLength(1));
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4 * 60_000);
        view = await render();
      }
      loseResponse = true;
      const retry = buttonNamed(view, action);
      retry.click();
      await vi.waitFor(() => {
        expect(loseResponse).toBe(false);
        expect(retry.disabled).toBe(false);
      });
      // A dropped response replaces the host and page before the operator retries.
      Object.assign(ui.s.context, { host: { ...ui.s.context.host } });
      buttonNamed(await render(), action).click();
      await vi.waitFor(() => expect(sends()).toHaveLength(action === "Repair" ? 2 : 3));
      const sent = sends();
      expect(sent.at(-1)!.idempotencyKey).toBe(sent.at(-2)!.idempotencyKey);
      expect(sent.map((send) => send.sessionKey)).toEqual(
        Array(sent.length).fill(existing ? "s-review" : "agent:main:repair:1"),
      );
      expect(create).toHaveBeenCalledTimes(existing ? 0 : 1);
      if (action === "Try again") {
        expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
      }
    } finally {
      vi.restoreAllMocks();
      ui.s.disposed = true;
      events.get("cron.inventory.changed")?.();
    }
  },
);

it("repairs an archived scribe by restoring its conversation and turning it on, without a turn", async () => {
  const { render, ui, calls } = fixture({
    sessions: {
      "Scribe · Knowledge Consolidation": {
        key: "s-review",
        sessionId: "sid-review",
        displayName: "Scribe · Knowledge Consolidation",
        archived: true,
      },
    },
    // Archiving the conversation turned its automation off.
    jobs: [{ ...reviewJob, enabled: false }],
  });
  ui.s.scribe = "claim-consolidation";
  const view = await render();
  expect(view.querySelector(".scribe-chip-warn")?.textContent).toBe("Conversation not found");
  expect(buttonNamed(view, "Run now")).toBeUndefined();
  buttonNamed(view, "Repair").click();
  await vi.waitFor(() => expect(calls.at(-1)?.[0]).toBe("cron.update"));
  expect(calls.slice(-2)).toEqual([
    [
      "sessions.patch",
      { key: "s-review", agentId: "main", archived: false, expectedSessionId: "sid-review" },
    ],
    [
      "cron.update",
      { id: "job-review", patch: { enabled: true }, expectedConfigRevision: "rev-7" },
    ],
  ]);
  expect(calls.some(([method]) => method === "chat.send")).toBe(false);
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
    sessionTarget: "session:s-conv",
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
