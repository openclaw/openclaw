import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { napcatOnboardingAdapter } from "./onboarding.js";
import type { NapCatConfig } from "./types.js";

function createPrompter(params: {
  confirmQueue: boolean[];
  textQueue: string[];
  note?: WizardPrompter["note"];
}): WizardPrompter {
  const confirmQueue = [...params.confirmQueue];
  const textQueue = [...params.textQueue];
  const confirm = vi.fn(async () => {
    const next = confirmQueue.shift();
    if (next === undefined) {
      throw new Error("unexpected confirm prompt");
    }
    return next;
  }) as WizardPrompter["confirm"];
  const text = vi.fn(async () => {
    const next = textQueue.shift();
    if (next === undefined) {
      throw new Error("unexpected text prompt");
    }
    return next;
  }) as WizardPrompter["text"];
  return buildWizardPrompter({
    confirm,
    text,
    note: params.note ?? (vi.fn(async () => {}) as WizardPrompter["note"]),
  });
}

describe("napcatOnboardingAdapter.configure", () => {
  it("re-prompts until at least one inbound transport is enabled", async () => {
    const note = vi.fn(async () => {}) as WizardPrompter["note"];
    const result = await napcatOnboardingAdapter.configure({
      cfg: {} as OpenClawConfig,
      prompter: createPrompter({
        confirmQueue: [false, false, false, true],
        textQueue: ["token", "http://127.0.0.1:3000", "ws://127.0.0.1:3001", "3000"],
        note,
      }),
      forceAllowFrom: false,
    });

    const config = result.cfg.channels?.napcat as NapCatConfig | undefined;
    expect(config?.transport?.http?.enabled).toBe(false);
    expect(config?.transport?.ws?.enabled).toBe(true);
    expect(config?.transport?.ws?.url).toBe("ws://127.0.0.1:3001");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Enable at least one inbound transport"),
      "NapCat transport",
    );
  });
});
