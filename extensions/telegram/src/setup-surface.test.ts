import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it, vi } from "vitest";
import {
  createTestWizardPrompter,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
} from "../../../test/helpers/plugins/setup-wizard.js";
import { resolveTelegramAllowFromEntries } from "./setup-core.js";
import { telegramSetupWizard } from "./setup-surface.js";

async function runPrepare(cfg: OpenClawConfig, accountId: string) {
  return await runSetupWizardPrepare({
    prepare: telegramSetupWizard.prepare,
    cfg,
    accountId,
    options: {},
  });
}

async function runFinalize(cfg: OpenClawConfig, accountId: string) {
  const note = vi.fn(async () => undefined);

  await runSetupWizardFinalize({
    finalize: telegramSetupWizard.finalize,
    cfg,
    accountId,
    prompter: createTestWizardPrompter({ note }),
  });

  return note;
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

describe("resolveTelegramAllowFromEntries", () => {
  it("passes apiRoot through username lookups", async () => {
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be called");
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12345 } }),
    }));
    vi.stubGlobal("fetch", globalFetch);
    const proxyFetch = vi.fn();
    const fetchModule = await import("./fetch.js");
    const proxyModule = await import("./proxy.js");
    const resolveTelegramFetch = vi.spyOn(fetchModule, "resolveTelegramFetch");
    const makeProxyFetch = vi.spyOn(proxyModule, "makeProxyFetch");
    makeProxyFetch.mockReturnValue(proxyFetch as unknown as typeof fetch);
    resolveTelegramFetch.mockReturnValue(fetchMock as unknown as typeof fetch);

    try {
      const resolved = await resolveTelegramAllowFromEntries({
        entries: ["@user"],
        credentialValue: "tok",
        apiRoot: "https://custom.telegram.test/root/",
        proxyUrl: "http://127.0.0.1:8080",
        network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
      });

      expect(resolved).toEqual([{ input: "@user", resolved: true, id: "12345" }]);
      expect(makeProxyFetch).toHaveBeenCalledWith("http://127.0.0.1:8080");
      expect(resolveTelegramFetch).toHaveBeenCalledWith(proxyFetch, {
        network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://custom.telegram.test/root/bottok/getChat?chat_id=%40user",
        undefined,
      );
    } finally {
      makeProxyFetch.mockRestore();
      resolveTelegramFetch.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
