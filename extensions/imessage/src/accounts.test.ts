import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IMessageAccountConfig } from "./account-types.js";
import {
  collectIMessageDuplicateAccountSourceWarnings,
  hasExclusiveIMessageLocalDatabase,
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  resolveIMessageDuplicateSourceOwner,
} from "./accounts.js";

function config(accounts: Record<string, IMessageAccountConfig>, cliPath?: string) {
  return { channels: { imessage: { accounts, ...(cliPath ? { cliPath } : {}) } } };
}

function sourceOwner(cfg: ReturnType<typeof config>, accountId: string) {
  return resolveIMessageDuplicateSourceOwner({
    cfg,
    account: resolveIMessageAccount({ cfg, accountId }),
  });
}

function remote(remoteHost: string): IMessageAccountConfig {
  return { cliPath: "/usr/local/bin/imsg-ssh", dbPath: "/Users/bot/Messages/chat.db", remoteHost };
}

describe("resolveIMessageAccount", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = config({ work: { enabled: false } }, "/usr/local/bin/imsg");

    expect(listIMessageAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultIMessageAccountId(cfg)).toBe("default");
    expect(resolveIMessageAccount({ cfg }).config.cliPath).toBe("/usr/local/bin/imsg");
  });
});

describe("iMessage duplicate-source watcher ownership", () => {
  it("assigns one watcher and doctor warning for a home-relative default database", () => {
    const cfg = config({
      primary: { cliPath: "imsg" },
      secondary: { dbPath: "~/Library/Messages/chat.db" },
    });
    expect(sourceOwner(cfg, "primary")).toBeUndefined();
    expect(sourceOwner(cfg, "secondary")).toBe("primary");
    expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toHaveLength(1);
  });

  it.each([
    [remote("bot@primary.example"), remote("bot@secondary.example")],
    [{ cliPath: "imsg" }, { cliPath: "imsg", remoteHost: "bot@remote.example" }],
  ])("preserves independent watchers for %j / %j", (primary, secondary) => {
    const cfg = config({ primary, secondary });
    expect({
      owners: [sourceOwner(cfg, "primary"), sourceOwner(cfg, "secondary")],
      warnings: collectIMessageDuplicateAccountSourceWarnings({ cfg }),
    }).toEqual({ owners: [undefined, undefined], warnings: [] });
  });

  it("never lets an unconfigured account own or warn for the only startable watcher", () => {
    const cfg = config({ primary: {}, secondary: { enabled: true } });
    const unconfigured = resolveIMessageAccount({ cfg, accountId: "primary" });
    const configured = resolveIMessageAccount({ cfg, accountId: "secondary" });

    expect(unconfigured).toMatchObject({ enabled: true, configured: false });
    expect(configured).toMatchObject({ accountId: "secondary", enabled: true, configured: true });
    expect(resolveIMessageDuplicateSourceOwner({ cfg, account: unconfigured })).toBeUndefined();
    expect(resolveIMessageDuplicateSourceOwner({ cfg, account: configured })).toBeUndefined();
    expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toEqual([]);
  });
});

describe("iMessage local database account ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string, cliPath: string, firstDbPath: string, secondDbPath: string;
  beforeEach(() => {
    root = tempDirs.make("openclaw-imessage-account-db-");
    cliPath = path.join(root, "imsg");
    firstDbPath = path.join(root, "first.db");
    secondDbPath = path.join(root, "second.db");
    fs.writeFileSync(cliPath, Buffer.from("cafebabe", "hex"));
    fs.writeFileSync(firstDbPath, "");
    fs.writeFileSync(secondDbPath, "");
  });

  function hasExclusiveDatabase(otherAccounts: Record<string, IMessageAccountConfig>) {
    const cfg = config({
      work: { cliPath, dbPath: firstDbPath },
      ...otherAccounts,
    });
    return hasExclusiveIMessageLocalDatabase({
      cfg,
      account: resolveIMessageAccount({ cfg, accountId: "work" }),
      cliPath,
      dbPath: firstDbPath,
    });
  }

  it("rejects hard-linked paths to the same database", () => {
    const linkedDbPath = path.join(root, "linked.db");
    fs.linkSync(firstDbPath, linkedDbPath);
    expect(hasExclusiveDatabase({ home: { cliPath, dbPath: linkedDbPath } })).toBe(false);
  });

  it("accepts distinct proven local databases and ignores explicit remote accounts", () => {
    expect(
      hasExclusiveDatabase({
        home: { cliPath, dbPath: secondDbPath },
        remote: { cliPath: "/usr/local/bin/remote-imsg", remoteHost: "qa@example.invalid" },
      }),
    ).toBe(true);
  });

  it("fails closed when another local account source cannot be attested", () => {
    expect(hasExclusiveDatabase({ unknown: { cliPath: path.join(root, "unknown-imsg") } })).toBe(
      false,
    );
  });
});
