import { describe, expect, it, vi } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import {
  createTestWizardPrompter,
  runSetupWizardConfigure,
  type WizardPrompter,
} from "../../../test/helpers/extensions/setup-wizard.js";
import { resolveBlueBubblesAccount } from "./accounts.js";
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
      resolveAccount: (cfg, accountId) => resolveBlueBubblesAccount({ cfg, accountId }),
      resolveAllowFrom: ({ cfg, accountId }: { cfg: unknown; accountId: string }) =>
        resolveBlueBubblesAccount({
          cfg: cfg as Parameters<typeof resolveBlueBubblesAccount>[0]["cfg"],
          accountId,
        }).config.allowFrom ?? [],
    },
    setup: blueBubblesSetupAdapter,
  } as Parameters<typeof buildChannelSetupWizardAdapterFromSetupWizard>[0]["plugin"];
  return buildChannelSetupWizardAdapterFromSetupWizard({
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
