import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { telegramSetupWizard } from "./setup-surface.js";

async function runFinalize(cfg: OpenClawConfig, accountId: string) {
  const prompter = {
    note: vi.fn(async () => undefined),
  };

  await telegramSetupWizard.finalize?.({
    cfg,
    accountId,
    credentialValues: {},
    runtime: {} as never,
    prompter: prompter as never,
    forceAllowFrom: false,
  });

  return prompter.note;
}

describe("telegramSetupWizard.finalize", () => {
  it("shows global config commands for the default account", async () => {
    const note = await runFinalize(
      {
        channels: {
          telegram: {
            botToken: "tok",
          },
        },
      },
      DEFAULT_ACCOUNT_ID,
    );

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('openclaw config set channels.telegram.dmPolicy "allowlist"'),
      "Telegram DM access warning",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`openclaw config set channels.telegram.allowFrom '["YOUR_USER_ID"]'`),
      "Telegram DM access warning",
    );
  });

  it("shows account-scoped config commands for named accounts", async () => {
    const note = await runFinalize(
      {
        channels: {
          telegram: {
            accounts: {
              alerts: {
                botToken: "tok",
              },
            },
          },
        },
      },
      "alerts",
    );

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        'openclaw config set channels.telegram.accounts.alerts.dmPolicy "allowlist"',
      ),
      "Telegram DM access warning",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        `openclaw config set channels.telegram.accounts.alerts.allowFrom '["YOUR_USER_ID"]'`,
      ),
      "Telegram DM access warning",
    );
  });

  it("skips the warning when an allowFrom entry already exists", async () => {
    const note = await runFinalize(
      {
        channels: {
          telegram: {
            botToken: "tok",
            allowFrom: ["123"],
          },
        },
      },
      DEFAULT_ACCOUNT_ID,
    );

    expect(note).not.toHaveBeenCalled();
  });
});
