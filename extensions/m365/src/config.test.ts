import { describe, expect, it, vi } from "vitest";
import {
  M365_DEFAULT_ACCOUNT_ID,
  M365_DEFAULT_GRAPH_BASE_URL,
  parseM365PluginConfig,
  resolveM365Account,
  resolveM365PluginConfig,
} from "./config.js";

describe("m365 config", () => {
  it("parses account config without exposing unknown top-level input", () => {
    const parsed = parseM365PluginConfig({
      defaultAccountId: "ops",
      calendarWriteScopeProbeUserId: "calendar-probe@example.com",
      accounts: {
        ops: {
          mailboxUserId: "ops@example.com",
          allowedReplyDomains: ["example.com", "", "contoso.com"],
        },
      },
      ignored: true,
    });

    expect(parsed.defaultAccountId).toBe("ops");
    expect(parsed.calendarWriteScopeProbeUserId).toBe("calendar-probe@example.com");
    expect(parsed.accounts?.ops?.mailboxUserId).toBe("ops@example.com");
    expect(parsed.accounts?.ops?.allowedReplyDomains).toEqual(["example.com", "contoso.com"]);
    expect(parsed).not.toHaveProperty("ignored");
  });

  it("resolves env-backed defaults and a configured account", async () => {
    vi.stubEnv("M365_TENANT_ID", "tenant-env");
    vi.stubEnv("M365_CLIENT_ID", "client-env");
    vi.stubEnv("M365_CLIENT_SECRET", "secret-env");

    const resolved = await resolveM365PluginConfig({
      pluginConfig: {
        defaultAccountId: "ops",
        accounts: {
          ops: {
            mailboxUserId: "ops@example.com",
            authMode: "delegated",
            identityId: "ops-delegate",
          },
        },
      },
      config: {},
      env: process.env,
    });

    const account = resolveM365Account(resolved, "ops");
    expect(account).toMatchObject({
      accountId: "ops",
      authMode: "delegated",
      identityId: "ops-delegate",
      tenantId: "tenant-env",
      clientId: "client-env",
      clientSecret: "secret-env",
      mailboxUserId: "ops@example.com",
    });
    expect(resolved.graphBaseUrl).toBe(M365_DEFAULT_GRAPH_BASE_URL);
  });

  it("creates an implicit default account from env mailbox config", async () => {
    const resolved = await resolveM365PluginConfig({
      pluginConfig: {},
      config: {},
      env: {
        M365_MAILBOX_USER_ID: "assistant@example.com",
      } as NodeJS.ProcessEnv,
    });

    expect(resolved.defaultAccountId).toBe(M365_DEFAULT_ACCOUNT_ID);
    expect(resolved.accounts.default?.mailboxUserId).toBe("assistant@example.com");
  });
});
