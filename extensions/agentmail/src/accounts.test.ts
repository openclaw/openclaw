import { afterEach, describe, expect, it } from "vitest";
import { listAgentMailAccountIds, resolveAgentMailAccount } from "./accounts.js";
import { AgentMailChannelConfigSchema } from "./config-schema.js";

const paddedApi = " api-key ";
const apiVal = "api-key";
const paddedHook = " webhook-value ";
const hookVal = "webhook-value";
const sharedVal = "shared";

afterEach(() => {
  delete process.env.AGENTMAIL_API_KEY;
  delete process.env.AGENTMAIL_WEBHOOK_SECRET;
});

describe("AgentMail account config", () => {
  it("defaults to a deny-all allowlist and webhook mode when a secret is present", () => {
    const account = resolveAgentMailAccount({
      channels: {
        agentmail: {
          apiKey: paddedApi,
          inboxId: " inbox_123 ",
          webhookSecret: paddedHook,
        },
      },
    });

    expect(account).toMatchObject({
      accountId: "default",
      apiKey: apiVal,
      inboxId: "inbox_123",
      webhookSecret: hookVal,
      webhookPath: "/webhooks/agentmail",
      dmPolicy: "allowlist",
      allowFrom: [],
      mediaMaxBytes: 20 * 1024 * 1024,
    });
  });

  it("uses WebSocket mode by omission and gives named accounts distinct paths", () => {
    const cfg = {
      channels: {
        agentmail: {
          apiKey: sharedVal,
          accounts: {
            support: { inboxId: "inbox_support" },
          },
        },
      },
    };
    expect(listAgentMailAccountIds(cfg)).toEqual(["default", "support"]);
    expect(resolveAgentMailAccount(cfg, "support")).toMatchObject({
      webhookSecret: "",
      webhookPath: "/webhooks/agentmail/support",
    });
  });

  it("does not inherit the default account webhook path into named accounts", () => {
    const cfg = {
      channels: {
        agentmail: {
          apiKey: sharedVal,
          webhookPath: "/webhooks/agentmail",
          accounts: {
            support: { inboxId: "inbox_support" },
            billing: { inboxId: "inbox_billing", webhookPath: "/mail/billing" },
          },
        },
      },
    };
    expect(resolveAgentMailAccount(cfg, "support").webhookPath).toBe("/webhooks/agentmail/support");
    expect(resolveAgentMailAccount(cfg, "billing").webhookPath).toBe("/mail/billing");
  });

  it("requires an explicit wildcard for open access", () => {
    const runtime = AgentMailChannelConfigSchema.runtime;
    expect(runtime?.safeParse({ dmPolicy: "open", allowFrom: [] }).success).toBe(false);
    expect(runtime?.safeParse({ dmPolicy: "open", allowFrom: ["*"] }).success).toBe(true);
    expect(
      runtime?.safeParse({
        allowFrom: ["*"],
        accounts: { support: { dmPolicy: "open", inboxId: "inbox_support" } },
      }).success,
    ).toBe(true);
    expect(
      runtime?.safeParse({
        accounts: { support: { dmPolicy: "open", inboxId: "inbox_support" } },
      }).success,
    ).toBe(false);
  });

  it("does not materialize account defaults that shadow channel inheritance", () => {
    const result = AgentMailChannelConfigSchema.runtime?.safeParse({
      dmPolicy: "open",
      allowFrom: ["*"],
      mediaMaxMb: 50,
      accounts: { support: { inboxId: "inbox_support" } },
    });
    expect(result?.success).toBe(true);
    if (!result?.success) {
      throw new Error("expected AgentMail config to parse");
    }
    const parsed = result.data;
    expect(parsed?.accounts?.support).not.toHaveProperty("dmPolicy");
    expect(parsed?.accounts?.support).not.toHaveProperty("mediaMaxMb");
    expect(
      resolveAgentMailAccount({ channels: { agentmail: parsed } } as never, "support"),
    ).toMatchObject({ dmPolicy: "open", mediaMaxBytes: 50 * 1024 * 1024 });
  });
});
