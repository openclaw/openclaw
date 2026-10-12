import { describe, expect, it } from "vitest";
import { resolveImapConfig } from "./config.js";
import { createImapTestRuntime } from "./imap-test-support.js";
import { countImapSkip, rememberImapMessage } from "./state.js";

describe("IMAP durable watcher state", () => {
  it("keeps healthy accounts available when a sibling SecretRef could not resolve", () => {
    const config = resolveImapConfig({
      accounts: {
        healthy: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: "resolved-password",
          agentId: "mail_reader",
        },
        unavailable: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: { source: "env", provider: "default", id: "MISSING_IMAP_PASSWORD" },
          agentId: "mail_reader",
        },
      },
    });
    expect(Object.keys(config.accounts)).toEqual(["healthy"]);
  });

  it("deduplicates logical Message-IDs without growing the account ring", async () => {
    const { state } = createImapTestRuntime();
    for (let index = 0; index < 101; index++) {
      expect(await rememberImapMessage(state, "account", `<${index}@example.com>`)).toBe(true);
    }
    expect(await rememberImapMessage(state, "account", "<100@example.com>")).toBe(false);
    expect((await state.messageIds.lookup("account"))?.messageIds).toHaveLength(100);
  });

  it("increments final account skip counters", async () => {
    const { state } = createImapTestRuntime();
    await countImapSkip(state, "account", "temperror");
    await countImapSkip(state, "account", "temperror");
    expect(await state.skips.lookup("account:temperror")).toEqual({ count: 2 });
  });
});
