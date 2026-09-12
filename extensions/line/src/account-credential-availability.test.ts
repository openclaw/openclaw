// Line tests cover what a credential that cannot be read is allowed to claim.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasLineCredentials } from "./account-helpers.js";
import { resolveLineAccount } from "./accounts.js";
import { lineChannelPluginCommon } from "./channel-shared.js";
import { lineMessageActions } from "./rich-messages.js";
import { sendMessageLine } from "./send.js";
import { isLineConfigured } from "./setup-core.js";
import { lineStatusAdapter } from "./status.js";

let dir: string;
let missing: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "line-credential-availability-"));
  missing = join(dir, "not-created.txt");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lineCfg(line: Record<string, unknown>): OpenClawConfig {
  return { channels: { line: { enabled: true, ...line } } } as OpenClawConfig;
}

function accountFor(line: Record<string, unknown>) {
  return resolveLineAccount({ cfg: lineCfg(line), accountId: "default" });
}

const { config } = lineChannelPluginCommon;

// `undefined` is how core discovers a channel other than the current one: with no account.
function messageToolActions(line: Record<string, unknown>, accountId: string | undefined) {
  return lineMessageActions.describeMessageTool?.({ cfg: lineCfg(line), accountId })?.actions;
}

async function statusFor(line: Record<string, unknown>) {
  const snapshot = await lineStatusAdapter.buildAccountSnapshot?.({
    cfg: lineCfg(line),
    account: accountFor(line),
  });
  if (!snapshot) {
    throw new Error("LINE status snapshot builder is unavailable");
  }
  return { snapshot, issues: lineStatusAdapter.collectStatusIssues?.([snapshot]) };
}

describe("an account whose credential file cannot be read", () => {
  it("cannot run, but stays configured wherever the account is described", async () => {
    const line = { tokenFile: missing, channelSecret: "secret" };
    const account = accountFor(line);

    // The config named a source that could not be read: neither missing nor usable.
    expect(account.tokenStatus).toBe("configured_unavailable");
    expect(config.isConfigured(account)).toBe(false);
    // Status keeps it visible as configured but unavailable, as core does for a blocked
    // account, instead of telling the operator that nothing was configured.
    expect(config.describeAccount(account)).toMatchObject({
      configured: true,
      tokenStatus: "configured_unavailable",
    });
    const { snapshot, issues } = await statusFor(line);
    expect(snapshot).toMatchObject({ configured: true, tokenStatus: "configured_unavailable" });
    expect(issues).toEqual([]);
    expect(isLineConfigured(lineCfg(line), "default")).toBe(true);
  });

  it("withholds the message tool the model would otherwise be told it can use", () => {
    // Offering send here hands the model a tool whose every call fails: the channel
    // refuses to start on the same credentials.
    const unreadableToken = { tokenFile: missing, channelSecret: "secret" };
    expect(messageToolActions(unreadableToken, "default")).toEqual([]);
    expect(
      messageToolActions({ channelAccessToken: "token", secretFile: missing }, "default"),
    ).toEqual([]);
    // With no account named, a single unreadable one still has nothing that can send.
    expect(messageToolActions(unreadableToken, undefined)).toEqual([]);
  });

  it("offers the message tool through a healthy account when discovery names none", () => {
    // Core discovers a channel other than the current one without an account and asks
    // for the configured-account union, so an unreadable default must not hide a
    // healthy second account.
    const line = {
      tokenFile: missing,
      channelSecret: "secret",
      accounts: { work: { channelAccessToken: "token", channelSecret: "secret" } },
    };

    expect(messageToolActions(line, undefined)).toEqual(["send"]);
    expect(messageToolActions(line, "default")).toEqual([]);
  });

  it("tells a send which token file could not be used instead of asking for a token", async () => {
    // A send can still name this account (CLI, cron, an explicit account id), and the
    // error it gets is the only place that operator learns what to fix.
    const cfg = lineCfg({ tokenFile: missing, channelSecret: "secret" });

    await expect(sendMessageLine("U123", "hello", { cfg })).rejects.toThrow(
      'LINE channel access token configured for account "default" is unavailable: channels.line.tokenFile could not be used (not-found).',
    );
  });

  it.skipIf(process.platform === "win32")(
    "names the account's own key and why a token file that exists was refused",
    async () => {
      // A symlinked file (a Kubernetes secret mount is one) reads fine from a shell, so
      // "could not be read" alone would send this operator to check the wrong thing.
      const target = join(dir, "token.txt");
      const link = join(dir, "token-link.txt");
      writeFileSync(target, "token");
      symlinkSync(target, link);
      const cfg = lineCfg({ accounts: { work: { tokenFile: link, channelSecret: "secret" } } });

      await expect(sendMessageLine("U123", "hello", { cfg, accountId: "work" })).rejects.toThrow(
        'account "work" is unavailable: channels.line.accounts.work.tokenFile could not be used (symlink).',
      );
    },
  );

  it("runs and offers the message tool while both credentials resolve", () => {
    const line = { channelAccessToken: "token", channelSecret: "secret" };

    expect(config.isConfigured(accountFor(line))).toBe(true);
    expect(messageToolActions(line, "default")).toEqual(["send"]);
  });

  it("still reports an account with no credentials at all as unconfigured", async () => {
    // The branch that already worked; it has to keep working after the change.
    const account = accountFor({});

    expect(account.tokenStatus).toBe("missing");
    expect(config.isConfigured(account)).toBe(false);
    expect(config.describeAccount(account)).toMatchObject({ configured: false });
    await expect(sendMessageLine("U123", "hello", { cfg: lineCfg({}) })).rejects.toThrow(
      'LINE channel access token missing for account "default"',
    );
  });

  it("falls back to the raw values when no credential status was resolved", () => {
    // An account without status fields falls back to the raw values; that branch
    // predates this change and has to keep answering.
    expect(hasLineCredentials({ channelAccessToken: "token", channelSecret: "secret" })).toBe(true);
    expect(hasLineCredentials({ channelAccessToken: "token" })).toBe(false);
  });
});
