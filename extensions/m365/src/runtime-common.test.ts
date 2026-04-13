import { describe, expect, it, vi } from "vitest";
import type { M365ResolvedPluginConfig } from "./config.js";
import { M365GraphApiError } from "./graph-client.js";
import type { M365GraphJsonClient } from "./graph-client.js";
import { verifyM365MailWriteScopeProof } from "./runtime-common.js";

function config(overrides: Partial<M365ResolvedPluginConfig> = {}): M365ResolvedPluginConfig {
  return {
    enabled: true,
    defaultAccountId: "default",
    graphBaseUrl: "https://graph.test/v1.0",
    tokenBaseUrl: "https://login.test",
    accounts: {
      default: {
        accountId: "default",
        enabled: true,
        authMode: "app-only",
        identityId: "assistant@example.com",
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        mailboxUserId: "assistant@example.com",
        folder: "inbox",
        maxBodyChars: 1000,
        allowedReplyDomains: [],
      },
    },
    triage: { limit: 10, sinceMinutes: 60, unreadOnly: true },
    allowedMailboxes: ["assistant@example.com"],
    mailWriteScopeProbeMailboxUserId: "outside-probe@example.com",
    allowedCalendars: [],
    approval: { timeoutMs: 300000, previewChars: 1200, teamsUserIds: ["approver-aad"] },
    webhook: {
      enabled: false,
      path: "/plugins/m365/notifications",
      expirationMinutes: 60,
      maxBodyBytes: 10000,
    },
    ...overrides,
  };
}

describe("m365 runtime-common", () => {
  it("fails closed when app-only mail writes are missing scope proof config", async () => {
    await expect(
      verifyM365MailWriteScopeProof({
        config: config({
          allowedMailboxes: [],
          mailWriteScopeProbeMailboxUserId: undefined,
        }),
        deps: {},
      }),
    ).rejects.toThrow("allowedMailboxes");
  });

  it("passes when the out-of-scope probe mailbox is denied with 403", async () => {
    const graphClientFactory = vi.fn(() => ({
      requestJson: vi.fn(async () => {
        throw new M365GraphApiError("forbidden", {
          status: 403,
          responseText: "forbidden",
        });
      }),
    }));

    await expect(
      verifyM365MailWriteScopeProof({
        config: config(),
        deps: { graphClientFactory },
      }),
    ).resolves.toBeUndefined();

    expect(graphClientFactory).toHaveBeenCalledTimes(1);
  });

  it("fails when the out-of-scope probe mailbox is still accessible", async () => {
    await expect(
      verifyM365MailWriteScopeProof({
        config: config(),
        deps: {
          graphClientFactory: () => ({
            requestJson: vi.fn(async () => ({
              value: [{ id: "msg-1" }],
            })) as unknown as M365GraphJsonClient["requestJson"],
          }),
        },
      }),
    ).rejects.toThrow("scope proof failed");
  });
});
