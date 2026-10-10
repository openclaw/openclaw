// Imessage tests cover accounts plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

describe("resolveIMessageAccount", () => {
  it("resolves independent enabled and configured state for explicitly enabled named account", () => {
    expect(
      resolveIMessageAccount({
        cfg: { channels: { imessage: { accounts: { work: { enabled: true } } } } },
        accountId: "work",
      }),
    ).toMatchObject({ accountId: "work", enabled: true, configured: true });
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        imessage: {
          cliPath: "/usr/local/bin/imsg",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } as never;

    expect(listIMessageAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultIMessageAccountId(cfg)).toBe("default");
    expect(resolveIMessageAccount({ cfg }).config.cliPath).toBe("/usr/local/bin/imsg");
  });
});

describe("iMessage duplicate-source watcher ownership", () => {
  it("assigns one watcher and doctor warning for a home-relative default database", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            primary: { cliPath: "imsg" },
            secondary: { dbPath: "~/Library/Messages/chat.db" },
          },
        },
      },
    } as never;

    expect(
      resolveIMessageDuplicateSourceOwner({
        cfg,
        account: resolveIMessageAccount({ cfg, accountId: "primary" }),
      }),
    ).toBeUndefined();
    expect(
      resolveIMessageDuplicateSourceOwner({
        cfg,
        account: resolveIMessageAccount({ cfg, accountId: "secondary" }),
      }),
    ).toBe("primary");
    expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toHaveLength(1);
  });

  it.each([
    {
      name: "different remote hosts behind the same wrapper",
      first: {
        cliPath: "/usr/local/bin/imsg-ssh",
        dbPath: "/Users/bot/Messages/chat.db",
        remoteHost: "bot@primary.example",
      },
      second: {
        cliPath: "/usr/local/bin/imsg-ssh",
        dbPath: "/Users/bot/Messages/chat.db",
        remoteHost: "bot@secondary.example",
      },
    },
    {
      name: "an explicitly remote and a local default binary",
      first: { cliPath: "imsg" },
      second: { cliPath: "imsg", remoteHost: "bot@remote.example" },
    },
  ])("preserves independent watchers for $name", ({ first, second }) => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            primary: first,
            secondary: second,
          },
        },
      },
    } as never;

    for (const accountId of ["primary", "secondary"]) {
      expect(
        resolveIMessageDuplicateSourceOwner({
          cfg,
          account: resolveIMessageAccount({ cfg, accountId }),
        }),
      ).toBeUndefined();
    }
    expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toEqual([]);
  });

  it("never lets an unconfigured account own or warn for the only startable watcher", () => {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            primary: {},
            secondary: { enabled: true, cliPath: "imsg" },
          },
        },
      },
    } as never;
    const unconfigured = resolveIMessageAccount({ cfg, accountId: "primary" });
    const configured = resolveIMessageAccount({ cfg, accountId: "secondary" });

    expect(unconfigured).toMatchObject({ enabled: true, configured: false });
    expect(configured).toMatchObject({ enabled: true, configured: true });
    expect(resolveIMessageDuplicateSourceOwner({ cfg, account: unconfigured })).toBeUndefined();
    expect(resolveIMessageDuplicateSourceOwner({ cfg, account: configured })).toBeUndefined();
    expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toEqual([]);
  });
});

describe("iMessage local database account ownership", () => {
  function createLocalFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imessage-account-db-"));
    const cliPath = path.join(root, "imsg");
    const firstDbPath = path.join(root, "first.db");
    const secondDbPath = path.join(root, "second.db");
    fs.writeFileSync(cliPath, Buffer.from("cafebabe", "hex"));
    fs.writeFileSync(firstDbPath, "");
    fs.writeFileSync(secondDbPath, "");
    return { root, cliPath, firstDbPath, secondDbPath };
  }

  let fixture: ReturnType<typeof createLocalFixture>;

  beforeEach(() => {
    fixture = createLocalFixture();
  });

  afterEach(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  function hasExclusiveDatabase(otherAccounts: Record<string, IMessageAccountConfig>) {
    const cfg = {
      channels: {
        imessage: {
          accounts: {
            work: { cliPath: fixture.cliPath, dbPath: fixture.firstDbPath },
            ...otherAccounts,
          },
        },
      },
    };
    return hasExclusiveIMessageLocalDatabase({
      cfg,
      account: resolveIMessageAccount({ cfg, accountId: "work" }),
      cliPath: fixture.cliPath,
      dbPath: fixture.firstDbPath,
    });
  }

  it("rejects hard-linked paths to the same database", () => {
    const linkedDbPath = path.join(fixture.root, "linked.db");
    fs.linkSync(fixture.firstDbPath, linkedDbPath);
    expect(hasExclusiveDatabase({ home: { cliPath: fixture.cliPath, dbPath: linkedDbPath } })).toBe(
      false,
    );
  });

  it("accepts distinct proven local databases and ignores explicit remote accounts", () => {
    expect(
      hasExclusiveDatabase({
        home: { cliPath: fixture.cliPath, dbPath: fixture.secondDbPath },
        remote: { cliPath: "/usr/local/bin/remote-imsg", remoteHost: "qa@example.invalid" },
      }),
    ).toBe(true);
  });

  it("fails closed when another local account source cannot be attested", () => {
    expect(
      hasExclusiveDatabase({ unknown: { cliPath: path.join(fixture.root, "unknown-imsg") } }),
    ).toBe(false);
  });
});
