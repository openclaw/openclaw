import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  type WizardPrompter,
} from "../../../test/helpers/extensions/setup-wizard.js";
import { synologyChatPlugin } from "./channel.js";
import { SynologyChatChannelConfigSchema } from "./config-schema.js";
import { buildSynologyChatInboundSessionKey } from "./session-key.js";

const synologyChatConfigure = createPluginSetupWizardConfigure(synologyChatPlugin);

describe("synology-chat core", () => {
  it("exports dangerouslyAllowNameMatching in the JSON schema", () => {
    const properties = (SynologyChatChannelConfigSchema.schema.properties ?? {}) as Record<
      string,
      { type?: string }
    >;

    expect(properties.dangerouslyAllowNameMatching?.type).toBe("boolean");
  });

  it("keeps the schema open for plugin-specific passthrough fields", () => {
    expect([true, {}]).toContainEqual(SynologyChatChannelConfigSchema.schema.additionalProperties);
  });

  it("isolates direct-message sessions by account and user", () => {
    const alpha = buildSynologyChatInboundSessionKey({
      agentId: "main",
      accountId: "alpha",
      userId: "123",
    });
    const beta = buildSynologyChatInboundSessionKey({
      agentId: "main",
      accountId: "beta",
      userId: "123",
    });
    const otherUser = buildSynologyChatInboundSessionKey({
      agentId: "main",
      accountId: "alpha",
      userId: "456",
    });

    expect(alpha).toBe("agent:main:synology-chat:alpha:direct:123");
    expect(beta).toBe("agent:main:synology-chat:beta:direct:123");
    expect(otherUser).toBe("agent:main:synology-chat:alpha:direct:456");
    expect(alpha).not.toBe(beta);
    expect(alpha).not.toBe(otherUser);
  });

  it("configures token and incoming webhook for the default account", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Synology Chat outgoing webhook token") {
          return "synology-token";
        }
        if (message === "Incoming webhook URL") {
          return "https://nas.example.com/webapi/entry.cgi?token=incoming";
        }
        if (message === "Outgoing webhook path (optional)") {
          return "";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: synologyChatConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.["synology-chat"]?.enabled).toBe(true);
    expect(result.cfg.channels?.["synology-chat"]?.token).toBe("synology-token");
    expect(result.cfg.channels?.["synology-chat"]?.incomingUrl).toBe(
      "https://nas.example.com/webapi/entry.cgi?token=incoming",
    );
  });

  it("records allowed user ids when setup forces allowFrom", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Synology Chat outgoing webhook token") {
          return "synology-token";
        }
        if (message === "Incoming webhook URL") {
          return "https://nas.example.com/webapi/entry.cgi?token=incoming";
        }
        if (message === "Outgoing webhook path (optional)") {
          return "";
        }
        if (message === "Allowed Synology Chat user ids") {
          return "123456, synology-chat:789012";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: synologyChatConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
      forceAllowFrom: true,
    });

    expect(result.cfg.channels?.["synology-chat"]?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.["synology-chat"]?.allowedUserIds).toEqual(["123456", "789012"]);
  });
});
