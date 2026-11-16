import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { hasRememberedNativeRuntimeConsent } from "../../config/native-runtime-consent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { requestNativeRuntimeConsent } from "./setup-consent.js";

const harness = {
  id: "native-fixture",
  label: "Native Fixture",
  executionEnvironment: "host-only",
} as const;

describe("native runtime setup consent", () => {
  it("stages only the chosen agent's consent and skips a repeated setup", async () => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { nativeRuntimeConsent: ["previous"] }, other: {} } },
    };
    const prompter = createWizardPrompter();
    const next = await requestNativeRuntimeConsent({ config, agentId: "main", harness, prompter });
    expect(next.agents?.entries?.main?.nativeRuntimeConsent).toEqual(["previous", harness.id]);
    expect(next.agents?.entries?.other?.nativeRuntimeConsent).toBeUndefined();
    expect(config.agents?.entries?.main?.nativeRuntimeConsent).toEqual(["previous"]);
    await requestNativeRuntimeConsent({ config: next, agentId: "main", harness, prompter });
    expect(prompter.select).toHaveBeenCalledOnce();
    await requestNativeRuntimeConsent({ config: next, agentId: "other", harness, prompter });
    expect(prompter.select).toHaveBeenCalledTimes(2);
  });

  it("preserves an authored agent key while using its normalized identity", async () => {
    const config: OpenClawConfig = { agents: { entries: { MAIN: {} } } };
    const prompter = createWizardPrompter();
    const next = await requestNativeRuntimeConsent({ config, agentId: "main", harness, prompter });
    expect(Object.keys(next.agents!.entries!)).toEqual(["MAIN"]);
    expect(hasRememberedNativeRuntimeConsent(next, "main", harness.id)).toBe(true);
    expect(
      await requestNativeRuntimeConsent({ config: next, agentId: "main", harness, prompter }),
    ).toBe(next);
    expect(prompter.select).toHaveBeenCalledOnce();
  });

  it("does not grant consent for a policy-capable harness or a non-interactive caller", async () => {
    const config = {};
    const prompter = createWizardPrompter();
    expect(
      await requestNativeRuntimeConsent({
        config,
        agentId: "main",
        harness: { id: "exact", label: "Exact" },
        prompter,
      }),
    ).toBe(config);
    expect(await requestNativeRuntimeConsent({ config, agentId: "main", harness })).toBe(config);
    expect(prompter.select).not.toHaveBeenCalled();
  });

  it("leaves config untouched when the operator cancels", async () => {
    const config = {};
    const prompter = createWizardPrompter();
    vi.mocked(prompter.select).mockRejectedValueOnce(new WizardCancelledError());
    await expect(
      requestNativeRuntimeConsent({ config, agentId: "main", harness, prompter }),
    ).rejects.toThrow(WizardCancelledError);
    expect(config).toEqual({});
  });

  it("rejects consent when authority is revoked while the prompt is open", async () => {
    const config = {};
    let current = true;
    const prompter = createWizardPrompter();
    vi.mocked(prompter.select).mockImplementationOnce(async () => {
      current = false;
      return "continue";
    });
    await expect(
      requestNativeRuntimeConsent({
        config,
        agentId: "main",
        harness,
        prompter,
        assertCurrent: () => {
          if (!current) {
            throw new Error("revoked");
          }
        },
      }),
    ).rejects.toThrow("revoked");
    expect(config).toEqual({});
  });
});
