/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { openStartDialog, pluginButton } from "./scribe-dialog.js";
import { settingsValue } from "./scribe-settings-dialog.js";
import { defaultOptions, runPrompt, scribeById, scribeSetup } from "./scribes-catalog.js";
import type { PluginReadiness, ScribeDetection, ScribeJob } from "./scribes-state.js";
import { fixture } from "./scribes-view.test-support.js";

const slack = scribeById("slack")!;
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// HTMLDialogElement is incomplete in jsdom.
Object.assign(HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) {
    this.open = true;
  },
  close(this: HTMLDialogElement) {
    this.open = false;
  },
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const open = (
  tokens?: NonNullable<ScribeDetection["tokens"]>[string],
  readiness: PluginReadiness = "ready",
) =>
  openStartDialog({
    scribe: slack,
    agentName: "Main",
    detection: { plugins: { slack: readiness }, ...(tokens && { tokens: { slack: tokens } }) },
    canWrite: true,
    canAdmin: true,
    basePath: "/ui",
    start: async () => {},
  });
const box = (dialog: HTMLDialogElement, id: string) =>
  dialog.querySelector<HTMLInputElement>(`#${id}`)!;
const startButton = (dialog: HTMLDialogElement) =>
  [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Start")!;

it("offers the Slack user token only when the account has one, and DMs on request", () => {
  const without = open({ bot: true, user: false });
  expect(without.textContent).toContain("Slack connected.");
  expect(box(without, "scribe-slack-user-token").disabled).toBe(true);
  expect(without.textContent).toContain("No Slack user token is configured");
  expect(without.querySelector("textarea")!.value).toBe(
    runPrompt(scribeSetup("slack", "ongoing", defaultOptions("slack"), timezone)),
  );
  document.body.replaceChildren();

  const withToken = open({ bot: true, user: true });
  expect(box(withToken, "scribe-slack-user-token").disabled).toBe(false);
  box(withToken, "scribe-slack-user-token").click();
  box(withToken, "scribe-slack-dms").click();
  expect(withToken.querySelector("textarea")!.value).toBe(
    runPrompt(
      scribeSetup(
        "slack",
        "ongoing",
        { ...defaultOptions("slack"), userToken: true, dms: true },
        timezone,
      ),
    ),
  );
  expect(startButton(withToken).disabled).toBe(false);
});

it("asks the owner to turn on the user token when the Slack account has no bot token", () => {
  const dialog = open({ bot: false, user: true });
  expect(dialog.textContent).toContain("This Slack account has no bot token");
  const tokenBox = box(dialog, "scribe-slack-user-token");
  expect(tokenBox.checked).toBe(false);
  expect(startButton(dialog).disabled).toBe(true);
  tokenBox.click();
  expect(startButton(dialog).disabled).toBe(false);
  expect(dialog.querySelector("textarea")!.value).toContain(
    "- Slack user token: also read every channel the owner's Slack user token can access",
  );
});

it("blocks starting until the Slack account runs, and connects it on the Channels page", () => {
  const dialog = open(undefined, "needs-sign-in");
  expect(dialog.textContent).toContain(
    "Slack plugin installed, not connected to your Slack account",
  );
  expect(startButton(dialog).disabled).toBe(true);
  const assign = vi.fn();
  vi.stubGlobal("location", { assign });
  pluginButton("/ui", slack.plugin!, "needs-sign-in").click();
  pluginButton("/ui", slack.plugin!, "missing").click();
  expect(assign.mock.calls).toEqual([["/ui/settings/channels"], ["/ui/plugins/openclaw/slack"]]);
});

it("lets a saved user-token opt-in be turned off after the user token is gone", () => {
  const { ui, page } = fixture({});
  const job: ScribeJob = {
    id: "job-slack",
    enabled: true,
    sessionTarget: "current",
    schedule: { kind: "cron", expr: "0 4 * * *" },
    state: {},
  };
  page.append(
    settingsValue(
      ui,
      {
        scribe: slack,
        status: "on",
        jobs: [job],
        runMessage: {
          state: "current",
          options: { since: "7d", userToken: true, dms: false },
        },
      },
      job,
      "main",
      { plugins: { slack: "ready" }, tokens: { slack: { bot: true, user: false } } },
    ),
  );
  page.querySelector<HTMLButtonElement>('button[aria-label="Change settings"]')!.click();
  const dialog = page.querySelector("dialog")!;
  const userToken = box(dialog, "scribe-slack-user-token");
  const save = [...dialog.querySelectorAll("button")].find(
    (b) => b.textContent === "Save settings",
  )!;
  expect([userToken.checked, userToken.disabled, save.disabled]).toEqual([true, false, true]);
  userToken.click();
  expect(save.disabled).toBe(false);
});
