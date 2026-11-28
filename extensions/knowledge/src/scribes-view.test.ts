/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { defaultOptions, runPrompt, scribeSetup, setupPrompt } from "./scribes-catalog.js";
import {
  buttonNamed,
  fixture,
  flush,
  reviewJob,
  reviewSession,
} from "./scribes-view.test-support.js";

afterEach(() => document.body.replaceChildren());

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
  const runMessage = runPrompt(
    scribeSetup("granola", "ongoing", defaultOptions("granola"), timezone),
  );
  expect(dialog.querySelector("textarea")!.value).toBe(runMessage);
  expect(dialog.textContent).toContain("requests its first run now");
  buttonNamed(dialog, "Start").click();
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  // The page writes the automation itself, as the administrator, then requests its first run.
  expect(calls.some(([method]) => method === "chat.send")).toBe(false);
  expect(calls.filter(([method]) => method.startsWith("cron.") && method !== "cron.list")).toEqual([
    [
      "cron.add",
      {
        delivery: { mode: "none" },
        failureAlert: { after: 2 },
        name: "Knowledge scribe · Learn from Granola",
        sessionKey: "agent:main:dock:new",
        sessionTarget: "current",
        enabled: true,
        schedule: { kind: "cron", expr: "0 10,14,18 * * 1-5", tz: timezone },
        agentId: "main",
        declarationKey: "knowledge:scribe:granola",
        payload: { toolsAllow: ["*"], kind: "agentTurn", message: runMessage },
      },
    ],
    ["cron.run", { id: "job-new", mode: "force" }],
  ]);
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
  await vi.waitFor(() => expect(calls.some(([method]) => method === "cron.run")).toBe(true));
  const add = calls.find(([method]) => method === "cron.add")![1]!;
  expect(add.schedule).toEqual({ kind: "cron", expr: schedule, tz: timezone });
  expect(add.payload).toEqual({
    toolsAllow: ["*"],
    kind: "agentTurn",
    message: runPrompt(scribeSetup("claim-consolidation", "ongoing", { schedule }, timezone)),
  });
});

it("saves a hand-edited run message and stops regenerating it until asked", async () => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { render, calls, page } = fixture({});
  const view = await render();
  buttonNamed(view, "Turn on…").click();
  const dialog = page.querySelector("dialog")!;
  const text = dialog.querySelector("textarea")!;
  const edited = `${text.value}\nAlso tidy page titles.`;
  text.value = edited;
  text.dispatchEvent(new Event("input"));
  expect(dialog.textContent).toContain("Edited by hand.");
  (dialog.querySelector("#scribe-review-nightly") as HTMLInputElement).click();
  expect(text.value, "a choice no longer overwrites the edit").toBe(edited);
  buttonNamed(dialog, "Use generated prompt").click();
  expect(text.value).toBe(
    runPrompt(scribeSetup("claim-consolidation", "ongoing", { schedule: "45 3 * * *" }, timezone)),
  );
  text.value = "  ";
  text.dispatchEvent(new Event("input"));
  expect(buttonNamed(dialog, "Turn on").disabled, "an empty prompt can't start").toBe(true);
  text.value = edited;
  text.dispatchEvent(new Event("input"));
  buttonNamed(dialog, "Turn on").click();
  await vi.waitFor(() => expect(calls.some(([method]) => method === "cron.add")).toBe(true));
  const add = calls.find(([method]) => method === "cron.add")![1]!;
  expect(add.payload).toEqual({ toolsAllow: ["*"], kind: "agentTurn", message: edited });
  // The choice made while the text was edited still picks the schedule.
  expect(add.schedule).toEqual({ kind: "cron", expr: "45 3 * * *", tz: timezone });
});

it("discards a hand edit when switching between once and ongoing", async () => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { render, page } = fixture({});
  buttonNamed(await render(), "Set up…").click();
  const dialog = page.querySelector("dialog")!;
  const text = dialog.querySelector("textarea")!;
  text.value = "Run differently.";
  text.dispatchEvent(new Event("input"));
  (dialog.querySelector("#scribe-often-once") as HTMLInputElement).click();
  expect(text.value).toBe(
    setupPrompt(scribeSetup("conversations", "once", defaultOptions("conversations"), timezone)),
  );
  expect(dialog.textContent).toContain("Generated from your choices.");
});

it("restarts a turned-off scribe's automation in its existing conversation", async () => {
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
  const dialog = page.querySelector("dialog")!;
  expect(dialog.textContent).toContain("(created if needed)");
  expect(dialog.textContent).toContain("Runs use the conversation’s model settings.");
  buttonNamed(dialog, "Start").click();
  await vi.waitFor(() => expect(calls.some(([method]) => method === "cron.run")).toBe(true));
  expect(create).not.toHaveBeenCalled();
  expect(calls.find(([method]) => method === "cron.add")![1]!.sessionKey).toBe("s-conv");
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

it("retries a failed start in the conversation it already created", async () => {
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
  // The rejected first add bypasses the recorder; the retry is the one recorded add.
  const adds = calls.filter(([method]) => method === "cron.add");
  expect(adds.map(([, params]) => params?.sessionKey)).toEqual(["agent:main:dock:new"]);
});

it("keeps one idempotency key per dialog and gives each dialog its own", async () => {
  const { render, request, calls, page } = fixture({});
  const view = await render();
  const sendKeys = () =>
    calls.filter(([method]) => method === "chat.send").map(([, params]) => params?.idempotencyKey);
  const runOnce = (dialog: HTMLDialogElement) =>
    (dialog.querySelector("#scribe-often-once") as HTMLInputElement).click();
  buttonNamed(view, "Set up…").click();
  const first = page.querySelector("dialog")!;
  runOnce(first);
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
  runOnce(page.querySelector("dialog")!);
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

it("lets a writer without administrator access run a scribe once, but not schedule one", async () => {
  const { render, ui, page, calls } = fixture({
    canAdmin: false,
    sessions: reviewSession,
    jobs: [{ ...reviewJob, scheduledToolPolicy: { mode: "account" } }],
  });
  const view = await render();
  // Without an administrator the page never rewrites earlier automations.
  expect(calls.some(([method]) => method === "cron.remove" || method === "cron.add")).toBe(false);
  expect(view.textContent).toContain("Scribe automations need a Gateway administrator");
  const setUp = buttonNamed(view, "Set up…");
  expect(setUp.disabled).toBe(false);
  setUp.click();
  const dialog = page.querySelector("dialog")!;
  expect(buttonNamed(dialog, "Start").disabled).toBe(true);
  expect(dialog.textContent).toContain("needs a Gateway administrator");
  (dialog.querySelector("#scribe-often-once") as HTMLInputElement).click();
  expect(buttonNamed(dialog, "Start").disabled).toBe(false);
  dialog.remove();
  ui.s.scribe = "claim-consolidation";
  const detail = await render();
  for (const name of ["Run now", "Disable", "Remove automation…", "Upgrade automation…"]) {
    expect(buttonNamed(detail, name).disabled, name).toBe(true);
  }
  // Rescheduling a turn's automation would replace it, so that waits for Upgrade.
  expect(buttonNamed(detail, "Change…")).toBeUndefined();
});

it.each([false, true])(
  "runs, disables, enables and removes a scribe automation (running=%s)",
  async (running) => {
    const job = {
      ...reviewJob,
      state: { ...reviewJob.state, runningAtMs: running ? 1_793_080_000_000 : undefined },
    };
    const { render, ui, calls, open, load, page } = fixture({
      sessions: reviewSession,
      jobs: [job],
    });
    ui.s.scribe = "claim-consolidation";
    let view = await render();
    expect(view.textContent).toContain("1 recent run, all succeeded");
    expect(view.querySelector(".scribe-run span")?.textContent).toBe("9 filed · 2 pages created");
    expect(view.textContent).toContain("Alert after 2 failed runs");
    expect(view.textContent).toMatch(/Weekly on Sunday, 3:45\sAM/);
    buttonNamed(view, "Run now").click();
    await flush();
    expect(calls.at(-1)).toEqual(["cron.run", { id: "job-review", mode: "force" }]);
    expect(ui.announce).toHaveBeenCalledWith("Run requested for Knowledge Consolidation.");
    const disable = buttonNamed(view, running ? "Stop and disable" : "Disable");
    expect(disable).toBeDefined();
    disable.click();
    await flush();
    expect(calls.at(-1)).toEqual([
      "cron.update",
      { id: "job-review", patch: { enabled: false }, expectedConfigRevision: "rev-7" },
    ]);
    expect(ui.announce).toHaveBeenCalledWith("Automation disabled for Knowledge Consolidation.");
    job.enabled = false;
    job.state.runningAtMs = undefined;
    view = await render();
    expect(view.querySelector(".scribe-status")?.textContent).toContain("Disabled");
    buttonNamed(view, "Enable").click();
    await flush();
    expect(calls.at(-1)).toEqual([
      "cron.update",
      { id: job.id, patch: { enabled: true }, expectedConfigRevision: "rev-7" },
    ]);
    expect(ui.announce).toHaveBeenCalledWith("Automation enabled for Knowledge Consolidation.");
    expect(calls.filter(([method]) => method === "cron.run")).toHaveLength(1);
    job.enabled = true;
    view = await render();
    buttonNamed(view, "Open conversation").click();
    expect(open).toHaveBeenCalledWith({ sessionKey: "s-review", agentId: "main" });
    buttonNamed(view, "Remove automation…").click();
    const confirm = page.querySelector("dialog")!;
    buttonNamed(confirm, "Remove automation").click();
    await vi.waitFor(() =>
      expect(calls.at(-1)).toEqual([
        "cron.remove",
        { id: "job-review", expectedConfigRevision: "rev-7" },
      ]),
    );
    expect(load).toHaveBeenCalled();
  },
);

const currentReview = (schedule: "45 3 * * 0" | "45 3 * * *" = "45 3 * * 0") =>
  runPrompt(scribeSetup("claim-consolidation", "ongoing", { schedule }, "UTC"));
// The claims-only consolidation message an earlier version generated, before run amounts.
const earlierReview = () =>
  currentReview()
    .replace(/\n\nSettings:\n- Each run: [^\n]+/, "")
    .replace(
      /Follow every step of [^\n]+ even when no claim is left to link\./,
      'Follow the "Scribe runs" section of the knowledge-claim-consolidation skill: consolidate every claim that names no page until none is left to decide.',
    )
    .replace("; Timelines retired and left; pages reviewed, changed and left unchanged", "");

it("upgrades an automation an agent turn created only when the administrator chooses to", async () => {
  // Set up by an earlier Knowledge through a turn: account authority, an outdated message,
  // options saved on it, and paused.
  const turnCreated = {
    ...reviewJob,
    enabled: false,
    sessionKey: "s-review",
    sessionTarget: "current",
    scheduledToolPolicy: { mode: "account" },
    payload: {
      kind: "agentTurn",
      message: earlierReview(),
      thinking: "high",
      toolsAllow: ["read"],
    },
    idleOnly: true,
  };
  // A generated tool list is not an option the owner saved.
  const generatedTools = {
    ...turnCreated,
    id: "job-other",
    configRevision: "rev-3",
    sessionKey: "s-elsewhere",
    payload: { kind: "agentTurn", message: "x", toolsAllow: ["*"], toolsAllowIsDefault: true },
  };
  const { render, calls, ui, page } = fixture({
    sessions: reviewSession,
    jobs: [turnCreated, generatedTools],
  });
  const writes = () =>
    calls.filter(([method]) => ["cron.add", "cron.update", "cron.remove"].includes(method));
  // Loading never replaces it: the replacement can't keep the model account recorded on it.
  expect((await render()).querySelector(".scribe-row")?.textContent).toContain("Upgrade available");
  expect(writes()).toEqual([]);
  ui.s.scribe = "claim-consolidation";
  const view = await render();
  expect(view.querySelector(".scribe-update")?.textContent).toContain(
    "Its scheduled runs can't read channel plugins such as Slack.",
  );
  buttonNamed(view, "Upgrade automation…").click();
  const confirm = page.querySelector("dialog")!;
  expect(confirm.textContent).toContain("Runs then use your model account");
  buttonNamed(confirm, "Upgrade").click();
  await vi.waitFor(() => expect(confirm.open).toBe(false));
  // Removed first: a same-key automation would take the new declaration with its old authority.
  expect(writes()).toEqual([
    ["cron.remove", { id: "job-review", expectedConfigRevision: "rev-7" }],
    ["cron.remove", { id: "job-other", expectedConfigRevision: "rev-3" }],
    [
      "cron.add",
      {
        delivery: { mode: "none" },
        failureAlert: { after: 2 },
        idleOnly: true,
        name: "Knowledge scribe · Knowledge Consolidation",
        sessionKey: "s-review",
        sessionTarget: "current",
        enabled: false,
        schedule: reviewJob.schedule,
        agentId: "main",
        declarationKey: "knowledge:scribe:claim-consolidation",
        payload: {
          thinking: "high",
          toolsAllow: ["read"],
          kind: "agentTurn",
          message: currentReview(),
        },
      },
    ],
  ]);
  expect(calls.some(([method]) => method === "chat.send")).toBe(false);
  expect(ui.announce).toHaveBeenCalledWith("Knowledge Consolidation: automation upgraded.");
});

it("never updates an automation changed to another payload kind", async () => {
  // An update would replace the owner's script with the scribe's agent turn.
  const script = {
    ...reviewJob,
    sessionKey: "s-review",
    sessionTarget: "session:s-review",
    payload: { kind: "script", script: "return { notify: 'checked' }" },
  };
  const { render, calls } = fixture({ sessions: reviewSession, jobs: [script] });
  await render();
  expect(
    calls.some(([method]) => ["cron.add", "cron.update", "cron.remove"].includes(method)),
  ).toBe(false);
});

it("tries a failed update once per automation revision", async () => {
  const earlier = {
    ...reviewJob,
    sessionKey: "s-review",
    sessionTarget: "session:s-review",
    payload: { kind: "agentTurn", message: earlierReview() },
  };
  const { render, calls, request, ui } = fixture({ sessions: reviewSession, jobs: [earlier] });
  const answer = request.getMockImplementation()!;
  request.mockImplementation(async (method, params) => {
    if (method === "cron.update") {
      calls.push([method, params]);
      throw new Error("offline");
    }
    return answer(method, params);
  });
  await render();
  await render();
  expect(ui.announce).toHaveBeenCalledWith(
    "Knowledge Consolidation: the update failed. Error: offline If its automation is gone, set it up again from Scribes.",
  );
  expect(calls.filter(([method]) => method === "cron.update")).toHaveLength(1);
});

it("updates an administrator's earlier automation in place", async () => {
  const earlier = {
    ...reviewJob,
    sessionKey: "s-review",
    sessionTarget: "session:s-review",
    payload: { kind: "agentTurn", message: earlierReview() },
  };
  const { render, calls } = fixture({ sessions: reviewSession, jobs: [earlier] });
  await render();
  expect(calls.filter(([method]) => method === "cron.update")).toEqual([
    [
      "cron.update",
      {
        id: "job-review",
        patch: {
          name: "Knowledge scribe · Knowledge Consolidation",
          sessionKey: "s-review",
          sessionTarget: "current",
          enabled: true,
          schedule: reviewJob.schedule,
          payload: { kind: "agentTurn", message: currentReview() },
        },
        expectedConfigRevision: "rev-7",
      },
    ],
  ]);
  expect(calls.some(([method]) => method === "cron.remove" || method === "cron.add")).toBe(false);
});

it("offers an edited run message the current one and replaces it on confirm", async () => {
  const differing = `${earlierReview()}\nAlso tidy page titles.`;
  const job = {
    ...reviewJob,
    sessionKey: "s-review",
    sessionTarget: "current",
    payload: { kind: "agentTurn", message: differing },
  };
  const { render, ui, calls, page, load } = fixture({
    sessions: reviewSession,
    jobs: [job],
    runs: [{ ts: 1_793_000_000_000, status: "ok", runId: "r1", sessionKey: "s-run" }],
  });
  expect((await render()).querySelector(".scribe-row")?.textContent).toContain(
    "New run instructions",
  );
  // An edited message is never replaced on its own.
  expect(calls.some(([method]) => method === "cron.update")).toBe(false);
  ui.s.scribe = "claim-consolidation";
  const view = await render();
  expect(view.querySelector(".scribe-update")?.textContent).toContain(
    "differs from what this version of Knowledge generates",
  );
  expect(buttonNamed(view, "Open run")).toBeTruthy();
  buttonNamed(view, "Replace with new…").click();
  const confirm = page.querySelector("dialog")!;
  // Only the changed lines: the run amounts in, the claims-only step and counts out, the
  // every-step ones in.
  const changed = [...confirm.querySelectorAll("pre del, pre ins")].map((line) => line.textContent);
  expect(changed).toEqual([
    "+ Settings:\n",
    "+ - Each run: retire 15 written Timelines and review 6 pages.\n",
    "+ \n",
    expect.stringMatching(/^− 2\. Follow the "Scribe runs"/),
    expect.stringMatching(/^− 3\. End your reply .*withdrawn and left>`\.\n$/),
    expect.stringMatching(/^\+ 2\. Follow every step/),
    expect.stringMatching(/^\+ 3\. End your reply .*left unchanged>`\.\n$/),
    "− Also tidy page titles.\n",
  ]);
  buttonNamed(confirm, "Replace with new").click();
  await vi.waitFor(() => expect(confirm.open).toBe(false));
  expect(calls.findLast(([method]) => method === "cron.update")![1]).toMatchObject({
    id: "job-review",
    patch: { payload: { kind: "agentTurn", message: currentReview() } },
  });
  expect(ui.announce).toHaveBeenCalledWith("Knowledge Consolidation: run message replaced.");
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

it.each([true, false])(
  "repairs a failing scribe by declaring its automation on (existing conversation: %s)",
  async (existing) => {
    const failing = {
      ...reviewJob,
      enabled: false,
      sessionKey: "s-review",
      sessionTarget: "current",
      payload: { kind: "agentTurn", message: currentReview() },
      state: { ...reviewJob.state, autoDisabled: { reason: "consecutive-failures" } },
    };
    const { render, ui, calls, create } = fixture({
      sessions: existing ? reviewSession : {},
      jobs: [failing],
    });
    ui.s.scribe = "claim-consolidation";
    const view = await render();
    buttonNamed(view, "Repair").click();
    await vi.waitFor(() => expect(calls.at(-1)?.[0]).toBe(existing ? "cron.update" : "cron.add"));
    if (existing) {
      expect(create).not.toHaveBeenCalled();
      expect(calls.at(-1)![1]).toEqual({
        id: "job-review",
        patch: {
          name: "Knowledge scribe · Knowledge Consolidation",
          sessionKey: "s-review",
          sessionTarget: "current",
          enabled: true,
          schedule: reviewJob.schedule,
          payload: { kind: "agentTurn", message: currentReview() },
        },
        expectedConfigRevision: "rev-7",
      });
    } else {
      // A deleted conversation is replaced, and so is the automation: an edit can't move the
      // conversation it was recorded for.
      expect(create).toHaveBeenCalledTimes(1);
      expect(calls.slice(-2)).toEqual([
        ["cron.remove", { id: "job-review", expectedConfigRevision: "rev-7" }],
        [
          "cron.add",
          expect.objectContaining({
            sessionKey: "agent:main:dock:new",
            enabled: true,
            failureAlert: { after: 2 },
            payload: { toolsAllow: ["*"], kind: "agentTurn", message: currentReview() },
          }),
        ],
      ]);
    }
    expect(calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(ui.announce).toHaveBeenCalledWith("Repaired Knowledge Consolidation and turned it on.");
  },
);

it("repairs an archived scribe by restoring its conversation and turning it on", async () => {
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

it("repairs a scribe whose conversation is gone into a new one, replacing a turn's automation", async () => {
  const elsewhere = {
    ...reviewJob,
    id: "job-elsewhere",
    enabled: false,
    sessionKey: "s-gone",
    sessionTarget: "current",
    scheduledToolPolicy: { mode: "account" },
  };
  // Its conversation is gone, so the scribe reads as Conversation not found until it starts again.
  const { render, calls, ui, page } = fixture({ jobs: [elsewhere] });
  ui.s.scribe = "claim-consolidation";
  buttonNamed(await render(), "Repair…").click();
  // Replacing a turn's automation asks first, as Upgrade does.
  const dialog = page.querySelector("dialog")!;
  expect(dialog.textContent).toContain(
    "Runs then use your model account, and Recent runs starts over.",
  );
  expect(calls.some(([method]) => method === "cron.remove")).toBe(false);
  buttonNamed(dialog, "Repair").click();
  await vi.waitFor(() => expect(calls.some(([method]) => method === "cron.add")).toBe(true));
  expect(calls.find(([method]) => method === "cron.remove")![1]).toEqual({
    id: "job-elsewhere",
    expectedConfigRevision: "rev-7",
  });
  // Repair turns it on.
  expect(calls.find(([method]) => method === "cron.add")![1]).toMatchObject({
    sessionKey: "agent:main:dock:new",
    enabled: true,
  });
});

const userText = (content: string) => ({ role: "user", content });
const statusLine = (state: string, summary: string) => ({
  role: "assistant",
  content: `Done.\nScribe status: ${state} — ${summary}`,
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

it("recovers a conversation whose start never arrived or whose once turn stopped", async () => {
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
  // The review conversation never got its automation: it is startable again, in that conversation.
  buttonNamed(view, "Turn on…").click();
  buttonNamed(page.querySelector("dialog")!, "Turn on").click();
  await vi.waitFor(() => expect(calls.at(-1)?.[0]).toBe("cron.run"));
  expect(create).not.toHaveBeenCalled();
  expect(calls.find(([method]) => method === "cron.add")![1]!.sessionKey).toBe("s-review-empty");
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
  expect(ui.announce).not.toHaveBeenCalledWith("Run requested for Knowledge Consolidation.");
  expect(load).not.toHaveBeenCalled();
});

it("keeps failed run-history reads distinct from an empty history and recovers on reopen", async () => {
  const { render, ui, request, calls } = fixture({ sessions: reviewSession, jobs: [reviewJob] });
  ui.s.scribe = "claim-consolidation";
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (method, params) => {
    if (method === "cron.runs") {
      throw new Error("History unavailable");
    }
    return original(method, params);
  });
  const failed = await render();
  expect(failed.querySelector(".scribe-history")?.textContent).toContain(
    "Could not load recent runs.",
  );
  expect(failed.querySelector(".scribe-history")?.textContent).not.toContain("No runs yet.");
  request.mockImplementation(original);
  expect((await render()).querySelector(".scribe-history")?.textContent).toContain(
    "9 filed · 2 pages created",
  );
  expect(calls.some(([method]) => method === "cron.run")).toBe(false);
});

it("changes a scribe's schedule on its automation", async () => {
  const job = {
    ...reviewJob,
    sessionTarget: "current",
    sessionKey: "s-review",
    schedule: { kind: "cron", expr: "45 3 * * 0", tz: "America/Los_Angeles" },
    payload: { kind: "agentTurn", message: currentReview(), model: "provider/model" },
  };
  const { render, ui, calls, page } = fixture({ sessions: reviewSession, jobs: [job] });
  ui.s.scribe = "claim-consolidation";
  buttonNamed(await render(), "Change…").click();
  const dialog = page.querySelector("dialog")!;
  const save = buttonNamed(dialog, "Save schedule");
  // The current schedule is picked, so there is nothing to save yet.
  expect(dialog.querySelector<HTMLInputElement>("input:checked")?.id).toBe(
    "scribe-schedule-45-3-0",
  );
  expect(save.disabled).toBe(true);
  dialog.querySelector<HTMLInputElement>("#scribe-schedule-45-3-")!.click();
  expect(dialog.textContent).toContain("New schedule: Daily, 3:45 AM · America/Los_Angeles.");
  save.click();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  // The generated run message follows the nightly run amounts; other saved options stay.
  expect(calls.filter(([method]) => method === "cron.update")).toEqual([
    [
      "cron.update",
      {
        id: "job-review",
        patch: {
          name: "Knowledge scribe · Knowledge Consolidation",
          sessionKey: "s-review",
          sessionTarget: "current",
          enabled: true,
          schedule: { kind: "cron", expr: "45 3 * * *", tz: "America/Los_Angeles" },
          payload: { kind: "agentTurn", message: currentReview("45 3 * * *") },
        },
        expectedConfigRevision: "rev-7",
      },
    ],
  ]);
  expect(calls.some(([method]) => method === "chat.send")).toBe(false);
  expect(ui.announce).toHaveBeenCalledWith("Knowledge Consolidation: schedule changed.");
});

const conversationsSession = {
  "Scribe · Learn from conversations": {
    key: "s-conversations",
    displayName: "Scribe · Learn from conversations",
  },
};
const conversationsRun = (scope: "active" | "all") =>
  runPrompt(
    scribeSetup("conversations", "ongoing", { ...defaultOptions("conversations"), scope }, "UTC"),
  );
const conversationsJob = (message: string) => ({
  ...reviewJob,
  id: "job-conversations",
  declarationKey: "knowledge:scribe:conversations",
  sessionTarget: "current",
  sessionKey: "s-conversations",
  schedule: { kind: "cron", expr: "0 4 * * *", tz: "America/Los_Angeles" },
  payload: { kind: "agentTurn", message },
});
const settingsUpdate = (message: string) => [
  "cron.update",
  {
    id: "job-conversations",
    patch: {
      name: "Knowledge scribe · Learn from conversations",
      sessionKey: "s-conversations",
      sessionTarget: "current",
      enabled: true,
      schedule: { kind: "cron", expr: "0 4 * * *", tz: "America/Los_Angeles" },
      payload: { kind: "agentTurn", message },
    },
    expectedConfigRevision: "rev-7",
  },
];

it("changes a scribe's settings on its automation, read from its run message", async () => {
  const { render, ui, calls, page } = fixture({
    sessions: conversationsSession,
    jobs: [conversationsJob(conversationsRun("active"))],
  });
  ui.s.scribe = "conversations";
  const view = await render();
  expect(view.textContent).toContain("SettingsActive conversationsChange…");
  view.querySelector<HTMLButtonElement>('button[aria-label="Change settings"]')!.click();
  const dialog = page.querySelector("dialog")!;
  const save = buttonNamed(dialog, "Save settings");
  // The settings the run message was generated from are picked, so there is nothing to save yet.
  expect(dialog.querySelector<HTMLInputElement>("input:checked")?.id).toBe("scribe-which-active");
  expect(save.disabled).toBe(true);
  dialog.querySelector<HTMLInputElement>("#scribe-which-all")!.click();
  expect(save.disabled).toBe(false);
  save.click();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  // The same automation takes the run message generated from the new settings.
  expect(
    calls.filter(
      ([method]) => method.startsWith("cron.") && method !== "cron.list" && method !== "cron.runs",
    ),
  ).toEqual([settingsUpdate(conversationsRun("all"))]);
  expect(ui.announce).toHaveBeenCalledWith("Learn from conversations: settings changed.");
});

it("offers a reset instead of settings for a run message edited by hand", async () => {
  const edited = `${conversationsRun("all")}\nSkip work chats.`;
  const { render, ui, calls, page } = fixture({
    sessions: conversationsSession,
    jobs: [conversationsJob(edited)],
  });
  ui.s.scribe = "conversations";
  const view = await render();
  expect(view.textContent).toContain("Run message edited by hand, so its settings can't be read");
  expect(view.querySelector('button[aria-label="Change settings"]')).toBeNull();
  view.querySelector<HTMLButtonElement>('button[aria-label="Reset run message"]')!.click();
  const dialog = page.querySelector("dialog")!;
  expect(dialog.textContent).toContain("− Skip work chats.");
  buttonNamed(dialog, "Reset").click();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  expect(calls.filter(([method]) => method === "cron.update")).toEqual([
    settingsUpdate(conversationsRun("active")),
  ]);
});

it("asks for the upgrade before changing a turn-created scribe's settings", async () => {
  const { render, ui, calls } = fixture({
    sessions: conversationsSession,
    jobs: [
      { ...conversationsJob(conversationsRun("active")), scheduledToolPolicy: { mode: "account" } },
    ],
  });
  ui.s.scribe = "conversations";
  const view = await render();
  expect(view.textContent).toContain("SettingsUpgrade the automation to change its settings here");
  expect(view.querySelector('button[aria-label="Change settings"]')).toBeNull();
  expect(view.querySelector('button[aria-label="Reset run message"]')).toBeNull();
  expect(calls.some(([method]) => method === "cron.update" || method === "cron.remove")).toBe(
    false,
  );
});
