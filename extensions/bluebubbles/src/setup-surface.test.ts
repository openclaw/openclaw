import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import {
  createSetupWizardAdapter,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  type WizardPrompter,
} from "../../../test/helpers/extensions/setup-wizard.js";
import { resolveBlueBubblesAccount } from "./accounts.js";
import { BlueBubblesConfigSchema } from "./config-schema.js";
import {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
} from "./group-policy.js";
import { DEFAULT_WEBHOOK_PATH } from "./webhook-shared.js";

async function createBlueBubblesConfigureAdapter() {
  const { blueBubblesSetupAdapter, blueBubblesSetupWizard } = await import("./setup-surface.js");
  const plugin = {
    id: "bluebubbles",
    meta: {
      id: "bluebubbles",
      label: "BlueBubbles",
      selectionLabel: "BlueBubbles",
      docsPath: "/channels/bluebubbles",
      blurb: "iMessage via BlueBubbles",
    },
    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      resolveAccount: adaptScopedAccountAccessor(resolveBlueBubblesAccount),
      resolveAllowFrom: ({ cfg, accountId }: { cfg: unknown; accountId: string }) =>
        resolveBlueBubblesAccount({
          cfg: cfg as Parameters<typeof resolveBlueBubblesAccount>[0]["cfg"],
          accountId,
        }).config.allowFrom ?? [],
    },
    setup: blueBubblesSetupAdapter,
  } as Parameters<typeof createSetupWizardAdapter>[0]["plugin"];
  return createSetupWizardAdapter({
    plugin,
    wizard: blueBubblesSetupWizard,
  });
}

async function runBlueBubblesConfigure(params: { cfg: unknown; prompter: WizardPrompter }) {
  const adapter = await createBlueBubblesConfigureAdapter();
  type ConfigureContext = Parameters<NonNullable<typeof adapter.configure>>[0];
  return await runSetupWizardConfigure({
    configure: adapter.configure,
    cfg: params.cfg as ConfigureContext["cfg"],
    runtime: { ...console, exit: vi.fn() } as ConfigureContext["runtime"],
    prompter: params.prompter,
  });
}

describe("bluebubbles setup surface", () => {
  it("preserves existing password SecretRef and keeps default webhook path", async () => {
    const passwordRef = { source: "env", provider: "default", id: "BLUEBUBBLES_PASSWORD" };
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const text = vi.fn();

    const result = await runBlueBubblesConfigure({
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://127.0.0.1:1234",
            password: passwordRef,
          },
        },
      },
      prompter: createTestWizardPrompter({ confirm, text }),
    });

    expect(result.cfg.channels?.bluebubbles?.password).toEqual(passwordRef);
    expect(result.cfg.channels?.bluebubbles?.webhookPath).toBe(DEFAULT_WEBHOOK_PATH);
    expect(text).not.toHaveBeenCalled();
  });

  it("applies a custom webhook path when requested", async () => {
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const text = vi.fn().mockResolvedValueOnce("/custom-bluebubbles");

    const result = await runBlueBubblesConfigure({
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://127.0.0.1:1234",
            password: "secret",
          },
        },
      },
      prompter: createTestWizardPrompter({ confirm, text }),
    });

    expect(result.cfg.channels?.bluebubbles?.webhookPath).toBe("/custom-bluebubbles");
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Webhook path",
        placeholder: DEFAULT_WEBHOOK_PATH,
      }),
    );
  });

  it("validates server URLs before accepting input", async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false);
    const text = vi.fn().mockResolvedValueOnce("127.0.0.1:1234").mockResolvedValueOnce("secret");

    await runBlueBubblesConfigure({
      cfg: { channels: { bluebubbles: {} } },
      prompter: createTestWizardPrompter({ confirm, text }),
    });

    const serverUrlPrompt = text.mock.calls[0]?.[0] as {
      validate?: (value: string) => string | undefined;
    };
    expect(serverUrlPrompt.validate?.("bad url")).toBe("Invalid URL format");
    expect(serverUrlPrompt.validate?.("127.0.0.1:1234")).toBeUndefined();
  });

  it("disables the channel through the setup wizard", async () => {
    const { blueBubblesSetupWizard } = await import("./setup-surface.js");
    const next = blueBubblesSetupWizard.disable?.({
      channels: {
        bluebubbles: {
          enabled: true,
          serverUrl: "http://127.0.0.1:1234",
        },
      },
    });

    expect(next?.channels?.bluebubbles?.enabled).toBe(false);
  });
});

describe("BlueBubblesConfigSchema", () => {
  it("accepts account config when serverUrl and password are both set", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
      password: "secret", // pragma: allowlist secret
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts SecretRef password when serverUrl is set", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
      password: {
        source: "env",
        provider: "default",
        id: "BLUEBUBBLES_PASSWORD",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("requires password when top-level serverUrl is configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(parsed.error.issues[0]?.path).toEqual(["password"]);
    expect(parsed.error.issues[0]?.message).toBe(
      "password is required when serverUrl is configured",
    );
  });

  it("requires password when account serverUrl is configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        work: {
          serverUrl: "http://localhost:1234",
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(parsed.error.issues[0]?.path).toEqual(["accounts", "work", "password"]);
    expect(parsed.error.issues[0]?.message).toBe(
      "password is required when serverUrl is configured",
    );
  });

  it("allows password omission when serverUrl is not configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        work: {
          name: "Work iMessage",
        },
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("bluebubbles group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        bluebubbles: {
          groups: {
            "chat:primary": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveBlueBubblesGroupRequireMention({ cfg, groupId: "chat:primary" })).toBe(false);
    expect(resolveBlueBubblesGroupRequireMention({ cfg, groupId: "chat:other" })).toBe(true);
    expect(resolveBlueBubblesGroupToolPolicy({ cfg, groupId: "chat:primary" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveBlueBubblesGroupToolPolicy({ cfg, groupId: "chat:other" })).toEqual({
      allow: ["message.send"],
    });
  });
});
