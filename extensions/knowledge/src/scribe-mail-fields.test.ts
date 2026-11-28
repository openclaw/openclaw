/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { openStartDialog, pluginButton } from "./scribe-dialog.js";
import {
  defaultOptions,
  runPrompt,
  scribeById,
  scribeSetup,
  setupPrompt,
} from "./scribes-catalog.js";
import type { PluginReadiness } from "./scribes-state.js";
import { buttonNamed, fixture, reviewJob } from "./scribes-view.test-support.js";

const mail = scribeById("mail")!;
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

const open = (readiness: PluginReadiness = "ready") =>
  openStartDialog({
    scribe: mail,
    agentName: "Main",
    detection: { plugins: { composio: readiness } },
    canWrite: true,
    canAdmin: true,
    basePath: "/ui",
    start: async () => {},
  });
const startButton = (dialog: HTMLDialogElement) =>
  [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Start")!;

it("says the Composio sign-in and Gmail link are checked by each run, and follows the choices", () => {
  const dialog = open();
  expect(dialog.textContent).toContain(
    "Composio plugin on. This scribe reads through the Composio plugin.",
  );
  expect(dialog.textContent).toContain(
    "Each run first checks the Composio CLI's sign-in and its Gmail link",
  );
  const prompt = dialog.querySelector("textarea")!;
  expect(prompt.value).toBe(
    runPrompt(scribeSetup("mail", "ongoing", defaultOptions("mail"), timezone)),
  );
  dialog.querySelector<HTMLInputElement>("#scribe-mail-sent")!.click();
  const select = dialog.querySelector<HTMLSelectElement>("select")!;
  select.value = "30d";
  select.dispatchEvent(new Event("change"));
  dialog.querySelector<HTMLInputElement>("#scribe-mail-once")!.click();
  expect(prompt.value).toBe(
    setupPrompt(scribeSetup("mail", "once", { since: "30d", sent: false }, timezone)),
  );
  expect(startButton(dialog).disabled).toBe(false);
});

it("blocks starting until the Composio plugin is installed and on", () => {
  const dialog = open("missing");
  expect(dialog.textContent).toContain("Needs the Composio plugin, which is not installed");
  expect(startButton(dialog).disabled).toBe(true);
  const assign = vi.fn();
  vi.stubGlobal("location", { assign });
  pluginButton("/ui", mail.plugin!, "missing").click();
  expect(assign.mock.calls).toEqual([["/ui/plugins/composio/composio"]]);
});

it("changes which mail a started Mail scribe lists on its automation", async () => {
  const message = (sent: boolean) =>
    runPrompt(scribeSetup("mail", "ongoing", { ...defaultOptions("mail"), sent }, "UTC"));
  const schedule = { kind: "cron", expr: "0 8,12,16 * * 1-5", tz: "UTC" };
  const { render, ui, calls, page } = fixture({
    sessions: {
      "Scribe · Learn from Mail": { key: "s-mail", displayName: "Scribe · Learn from Mail" },
    },
    jobs: [
      {
        ...reviewJob,
        id: "job-mail",
        declarationKey: "knowledge:scribe:mail",
        sessionTarget: "current",
        sessionKey: "s-mail",
        schedule,
        payload: { kind: "agentTurn", message: message(true) },
      },
    ],
  });
  ui.s.scribe = "mail";
  const view = await render();
  expect(view.textContent).toContain("SettingsMail you received and sentChange…");
  view.querySelector<HTMLButtonElement>('button[aria-label="Change settings"]')!.click();
  const dialog = page.querySelector("dialog")!;
  const sent = dialog.querySelector<HTMLInputElement>("#scribe-mail-sent")!;
  const save = buttonNamed(dialog, "Save settings");
  expect([sent.checked, save.disabled]).toEqual([true, true]);
  sent.click();
  expect(save.disabled).toBe(false);
  save.click();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  expect(calls.filter(([method]) => method === "cron.update")).toEqual([
    [
      "cron.update",
      {
        id: "job-mail",
        patch: {
          name: "Knowledge scribe · Learn from Mail",
          sessionKey: "s-mail",
          sessionTarget: "current",
          enabled: true,
          schedule,
          payload: { kind: "agentTurn", message: message(false) },
        },
        expectedConfigRevision: "rev-7",
      },
    ],
  ]);
});
