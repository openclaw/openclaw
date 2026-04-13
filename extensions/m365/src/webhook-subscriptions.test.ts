import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { M365ResolvedAccountConfig, M365ResolvedPluginConfig } from "./config.js";
import {
  buildM365MailSubscriptionPayload,
  createM365WebhookHandler,
  parseM365MailNotifications,
} from "./webhook-subscriptions.js";

function account(): M365ResolvedAccountConfig {
  return {
    accountId: "default",
    enabled: true,
    authMode: "app-only",
    identityId: "default",
    tenantId: "tenant",
    clientId: "client",
    clientSecret: "secret",
    mailboxUserId: "assistant@example.com",
    folder: "inbox",
    maxBodyChars: 12000,
    allowedReplyDomains: [],
  };
}

function config(): M365ResolvedPluginConfig {
  return {
    enabled: true,
    defaultAccountId: "default",
    graphBaseUrl: "https://graph.test/v1.0",
    tokenBaseUrl: "https://login.test",
    accounts: { default: account() },
    triage: { limit: 10, sinceMinutes: 60, unreadOnly: true },
    allowedMailboxes: ["assistant@example.com"],
    allowedCalendars: [],
    approval: { timeoutMs: 300000, previewChars: 1000, teamsUserIds: [] },
    webhook: {
      enabled: true,
      path: "/plugins/m365/notifications",
      clientState: "client-state",
      notificationUrl: "https://openclaw.example/plugins/m365/notifications",
      expirationMinutes: 60,
      maxBodyBytes: 10000,
    },
  };
}

function mockReq(params: { method?: string; url?: string; body?: unknown }): IncomingMessage {
  const req = Readable.from([JSON.stringify(params.body ?? {})]) as IncomingMessage;
  req.method = params.method ?? "POST";
  req.url = params.url ?? "/plugins/m365/notifications";
  req.headers = { "content-type": "application/json" };
  Object.defineProperty(req, "socket", {
    value: { remoteAddress: "127.0.0.1" },
  });
  return req;
}

function mockRes(): ServerResponse & { body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    body: "",
    setHeader: vi.fn(),
    end(chunk?: unknown) {
      if (typeof chunk === "string") {
        res.body += chunk;
      } else if (chunk !== undefined) {
        res.body += JSON.stringify(chunk);
      }
      return res;
    },
  };
  return res as unknown as ServerResponse & { body: string; statusCode: number };
}

describe("m365 webhook and subscription helpers", () => {
  it("builds Graph subscription payloads for Outlook messages", () => {
    expect(
      buildM365MailSubscriptionPayload({
        account: account(),
        config: config(),
        notificationUrl: "https://openclaw.example/hook",
        clientState: "state",
        now: new Date("2026-04-13T00:00:00.000Z"),
      }),
    ).toEqual({
      changeType: "created,updated",
      notificationUrl: "https://openclaw.example/hook",
      resource: "users/assistant%40example.com/mailFolders/inbox/messages",
      expirationDateTime: "2026-04-13T01:00:00.000Z",
      clientState: "state",
    });
  });

  it("parses Graph mail notifications", () => {
    expect(
      parseM365MailNotifications({
        value: [
          {
            subscriptionId: "sub-1",
            clientState: "state",
            changeType: "created",
            resource: "users/x/messages/y",
            resourceData: { id: "msg-1" },
          },
        ],
      }),
    ).toEqual([
      {
        subscriptionId: "sub-1",
        clientState: "state",
        changeType: "created",
        resource: "users/x/messages/y",
        messageId: "msg-1",
      },
    ]);
  });

  it("accepts validationToken challenges", async () => {
    const handler = createM365WebhookHandler({
      config: config(),
      onNotifications: vi.fn(),
    });
    const res = mockRes() as ServerResponse & { body: string; statusCode: number };

    await handler(mockReq({ url: "/plugins/m365/notifications?validationToken=abc123" }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("abc123");
  });

  it("rejects invalid clientState notifications", async () => {
    const onNotifications = vi.fn();
    const handler = createM365WebhookHandler({
      config: config(),
      onNotifications,
    });
    const res = mockRes() as ServerResponse & { body: string; statusCode: number };

    await handler(
      mockReq({
        body: {
          value: [{ subscriptionId: "sub-1", clientState: "wrong" }],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(onNotifications).not.toHaveBeenCalled();
  });
});
