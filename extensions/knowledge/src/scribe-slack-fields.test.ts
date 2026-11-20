/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { openStartDialog, pluginButton } from "./scribe-dialog.js";
import { defaultOptions, scribeById, scribeSetup, setupPrompt } from "./scribes-catalog.js";
import type { ScribeDetection } from "./scribes-state.js";

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

const open = (detection: ScribeDetection) =>
  openStartDialog({
    scribe: slack,
    agentName: "Main",
    detection,
    canWrite: true,
    basePath: "/ui",
    start: async () => {},
  });
const box = (dialog: HTMLDialogElement, id: string) =>
  dialog.querySelector<HTMLInputElement>(`#${id}`)!;
const startButton = (dialog: HTMLDialogElement) =>
  [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Start")!;

it("offers the Slack user token only when the account has one, and DMs on request", () => {
  const without = open({ plugins: { slack: "ready" }, userTokens: { slack: false } });
  expect(without.textContent).toContain("Slack connected.");
  expect(box(without, "scribe-slack-user-token").disabled).toBe(true);
  expect(without.textContent).toContain("No Slack user token is configured");
  expect(without.querySelector("textarea")!.value).toBe(
    setupPrompt(scribeSetup("slack", "ongoing", defaultOptions("slack"), timezone)),
  );
  document.body.replaceChildren();

  const withToken = open({ plugins: { slack: "ready" }, userTokens: { slack: true } });
  expect(box(withToken, "scribe-slack-user-token").disabled).toBe(false);
  box(withToken, "scribe-slack-user-token").click();
  box(withToken, "scribe-slack-dms").click();
  expect(withToken.querySelector("textarea")!.value).toBe(
    setupPrompt(
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

it("blocks starting until the Slack account runs, and connects it on the Channels page", () => {
  const dialog = open({ plugins: { slack: "needs-sign-in" } });
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
