import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  createTestWizardPrompter,
  runSetupWizardFinalize,
  type WizardPrompter,
} from "../../../test/helpers/plugins/setup-wizard.js";
import { slackSetupWizard } from "./setup-surface.js";

describe("slackSetupWizard.finalize", () => {
  const baseCfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  } as OpenClawConfig;

  it("prompts to enable interactive replies for newly configured Slack accounts", async () => {
    const confirm = vi.fn(async () => true);

    const result = await runSetupWizardFinalize({
      finalize: slackSetupWizard.finalize,
      cfg: baseCfg,
      prompter: createTestWizardPrompter({
        confirm: confirm as WizardPrompter["confirm"],
      }),
    });
    if (!result?.cfg) {
      throw new Error("expected finalize to patch config");
    }

    expect(confirm).toHaveBeenCalledWith({
      message: "Enable Slack interactive replies (buttons/selects) for agent responses?",
      initialValue: true,
    });
    expect(
      (result.cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } })
        ?.capabilities?.interactiveReplies,
    ).toBe(true);
  });

  it("records an explicit false choice when the operator declines interactive replies", async () => {
    const result = await runSetupWizardFinalize({
      finalize: slackSetupWizard.finalize,
      cfg: baseCfg,
      prompter: createTestWizardPrompter({
        confirm: vi.fn(async () => false),
      }),
    });
    if (!result?.cfg) {
      throw new Error("expected finalize to patch config");
    }

    expect(
      (result.cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } })
        ?.capabilities?.interactiveReplies,
    ).toBe(false);
  });

  it("auto-enables interactive replies for quickstart defaults without prompting", async () => {
    const confirm = vi.fn(async () => false);

    const result = await runSetupWizardFinalize({
      finalize: slackSetupWizard.finalize,
      cfg: baseCfg,
      options: { quickstartDefaults: true },
      prompter: createTestWizardPrompter({
        confirm: confirm as WizardPrompter["confirm"],
      }),
    });
    if (!result?.cfg) {
      throw new Error("expected finalize to patch config");
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(
      (result.cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } })
        ?.capabilities?.interactiveReplies,
    ).toBe(true);
  });
});
