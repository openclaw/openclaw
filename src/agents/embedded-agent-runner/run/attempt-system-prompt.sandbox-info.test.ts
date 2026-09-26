// Caller coverage for optional elevation reporting with real session and approval readers.
import { expect, it } from "vitest";
import {
  withPromptFixture,
  type ElevationCase,
} from "./attempt-system-prompt.sandbox-info.test-support.js";

const disabled: ElevationCase = {
  name: "disabled",
  elevated: { enabled: false, allowed: false, defaultLevel: "off" },
  required: false,
};
const cases: ElevationCase[] = [
  { name: "absent", required: false },
  disabled,
  { ...disabled, name: "required and disabled", required: true },
  {
    name: "enabled and allowed",
    elevated: { enabled: true, allowed: true, defaultLevel: "off" },
    required: false,
    promptLine:
      "Current elevated level: off (full auto-approval unavailable here; use ask/on instead).",
  },
  {
    name: "enabled but disallowed",
    elevated: { enabled: true, allowed: false, defaultLevel: "off" },
    required: false,
    promptLine: "Current elevated level: off (elevated exec unavailable).",
  },
  {
    name: "required and enabled",
    elevated: { enabled: true, allowed: true, defaultLevel: "off" },
    required: true,
    promptLine: "Current elevated level: off (elevated exec unavailable).",
  },
];

it.each(cases)("prepares sandbox prompt reporting with elevation $name", async (testCase) => {
  await withPromptFixture(testCase, async ({ prepare, policyRead, approvalRead }) => {
    const prepared = await prepare();
    expect(prepared.systemPromptReport?.sandbox).toEqual({ mode: "all", sandboxed: true });
    expect(prepared.systemPromptText).toContain("## Sandbox");
    if (testCase.elevated?.enabled) {
      expect(policyRead).toHaveBeenCalled();
      if (!testCase.required) {
        expect(approvalRead).toHaveBeenCalled();
      }
      expect(prepared.systemPromptText).toContain(testCase.promptLine);
    } else {
      expect(policyRead).not.toHaveBeenCalled();
      expect(approvalRead).not.toHaveBeenCalled();
      expect(prepared.systemPromptText).not.toContain("Current elevated level:");
    }
  });
});

it("does not read elevation policy again for a disabled permission-prompt refresh", async () => {
  await withPromptFixture(disabled, async ({ prepare, tools, policyRead, approvalRead }) => {
    const prepared = await prepare();
    if (!prepared.prepareToolPrompt) {
      throw new Error("Expected the actual refreshable prompt entry");
    }
    policyRead.mockClear();
    approvalRead.mockClear();
    const refresh = await prepared.prepareToolPrompt(tools, { permissionChanged: true });
    const prompt = refresh(prepared.systemPromptText);
    expect(prompt).toContain("## Permission change");
    expect(prompt).toContain("## Sandbox");
    expect(prompt).not.toContain("Current elevated level:");
    expect(policyRead).not.toHaveBeenCalled();
    expect(approvalRead).not.toHaveBeenCalled();
  });
});

it.each(["abort", "close"] as const)(
  "retains the disabled-elevation refresh checkpoint after admission %s",
  async (action) => {
    await withPromptFixture(disabled, async ({ prepare, admission, abort, tools }) => {
      const prepared = await prepare();
      if (!prepared.prepareToolPrompt) {
        throw new Error("Expected the actual refreshable prompt entry");
      }
      const reason = new Error("synthetic prompt cancellation");
      if (action === "abort") {
        abort.abort(reason);
      } else {
        admission.close();
      }
      const refresh = prepared.prepareToolPrompt(tools, { permissionChanged: true });
      if (action === "abort") {
        await expect(refresh).rejects.toBe(reason);
      } else {
        await expect(refresh).rejects.toThrow("admitted run authority is no longer active");
      }
    });
  },
);
