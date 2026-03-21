import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { telegramSetupWizard } from "./setup-surface.js";

async function runPrepare(cfg: OpenClawConfig, accountId: string) {
  return await telegramSetupWizard.prepare?.({
    cfg,
    accountId,
    credentialValues: {},
    runtime: {} as never,
    prompter: {} as never,
    options: {},
  });
}

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

function expectPreparedResult(
  prepared: Awaited<ReturnType<typeof runPrepare>>,
): { cfg: OpenClawConfig } & Exclude<Awaited<ReturnType<typeof runPrepare>>, void | undefined> {
  expect(prepared).toBeDefined();
  if (
    !prepared ||
    typeof prepared !== "object" ||
    !("cfg" in prepared) ||
    prepared.cfg === undefined
  ) {
    throw new Error("Expected prepare result with cfg");
  }
  return prepared as { cfg: OpenClawConfig } & Exclude<
    Awaited<ReturnType<typeof runPrepare>>,
    void | undefined
  >;
}

describe("telegramSetupWizard.prepare", () => {
  it('adds groups["*"].requireMention=true for fresh setups', async () => {
    const prepared = expectPreparedResult(
      await runPrepare(
        {
          channels: {
            telegram: {
              botToken: "tok",
            },
          },
        },
        DEFAULT_ACCOUNT_ID,
      ),
    );

    expect(prepared.cfg.channels?.telegram?.groups).toEqual({
      "*": { requireMention: true },
    });
  });

  it("preserves an explicit wildcard group mention setting", async () => {
    const prepared = expectPreparedResult(
      await runPrepare(
        {
          channels: {
            telegram: {
              botToken: "tok",
              groups: {
                "*": { requireMention: false },
              },
            },
          },
        },
        DEFAULT_ACCOUNT_ID,
      ),
    );

    expect(prepared.cfg.channels?.telegram?.groups).toEqual({
      "*": { requireMention: false },
    });
  });
});

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
