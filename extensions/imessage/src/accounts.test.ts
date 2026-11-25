import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
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

function remote(remoteHost: string): IMessageAccountConfig {
  return { cliPath: "/usr/local/bin/imsg-ssh", dbPath: "/Users/bot/Messages/chat.db", remoteHost };
}

it("preserves top-level default account when named accounts are configured", () => {
  const cfg = config({ work: { enabled: false } }, "/usr/local/bin/imsg");

  expect(listIMessageAccountIds(cfg)).toEqual(["default", "work"]);
  expect(resolveDefaultIMessageAccountId(cfg)).toBe("default");
  expect(resolveIMessageAccount({ cfg }).config.cliPath).toBe("/usr/local/bin/imsg");
});

it.each<[IMessageAccountConfig, IMessageAccountConfig, string | undefined]>([
  [{ cliPath: "imsg" }, { dbPath: "~/Library/Messages/chat.db" }, "primary"],
  [remote("bot@primary.example"), remote("bot@secondary.example"), undefined],
  [{ cliPath: "imsg" }, { cliPath: "imsg", remoteHost: "bot@remote.example" }, undefined],
  [{}, { enabled: true }, undefined],
])("assigns watcher ownership for %j / %j", (primary, secondary, owner) => {
  const cfg = config({ primary, secondary });
  const owners = ["primary", "secondary"].map((accountId) =>
    resolveIMessageDuplicateSourceOwner({
      cfg,
      account: resolveIMessageAccount({ cfg, accountId }),
    }),
  );
  expect(owners).toEqual([undefined, owner]);
  expect(collectIMessageDuplicateAccountSourceWarnings({ cfg })).toHaveLength(owner ? 1 : 0);
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it.each(["hardlink", "separate", "unattested"])("attests a %s database source", (source) => {
  const root = tempDirs.make("openclaw-imessage-account-db-");
  const cliPath = path.join(root, "imsg");
  const firstDbPath = path.join(root, "first.db");
  const secondDbPath = path.join(root, "second.db");
  fs.writeFileSync(cliPath, Buffer.from("cafebabe", "hex"));
  fs.writeFileSync(firstDbPath, "");
  fs.writeFileSync(secondDbPath, "");
  const linkedDbPath = path.join(root, "linked.db");
  if (source === "hardlink") {
    fs.linkSync(firstDbPath, linkedDbPath);
  }
  const home =
    source === "unattested"
      ? { cliPath: path.join(root, "unknown-imsg") }
      : { cliPath, dbPath: source === "hardlink" ? linkedDbPath : secondDbPath };
  const cfg = config({
    work: { cliPath, dbPath: firstDbPath },
    home,
    remote: { cliPath: "/usr/local/bin/remote-imsg", remoteHost: "qa@example.invalid" },
  });
  expect(
    hasExclusiveIMessageLocalDatabase({
      cfg,
      account: resolveIMessageAccount({ cfg, accountId: "work" }),
      cliPath,
      dbPath: firstDbPath,
    }),
  ).toBe(source === "separate");
});
