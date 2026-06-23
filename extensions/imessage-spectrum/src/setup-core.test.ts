import type { ChannelSetupWizard, OpenClawConfig } from "openclaw/plugin-sdk/setup-runtime";
// iMessage Spectrum setup tests cover setup-time config patches.
import type { WizardPrompter } from "openclaw/plugin-sdk/setup-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  buildSpectrumWebhookRegistrationCurl,
  imessageSpectrumSetupPlugin,
  spectrumSetupAdapter,
} from "./setup-core.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("spectrumSetupAdapter", () => {
  it("requires Spectrum project credentials", () => {
    expect(
      spectrumSetupAdapter.validateInput?.({
        cfg: asConfig({}),
        accountId: "default",
        input: {},
      }),
    ).toBe("iMessage (Spectrum) requires --project-id and --project-secret.");
  });

  it("applies webhook setup fields to default account config", () => {
    const next = spectrumSetupAdapter.applyAccountConfig({
      cfg: asConfig({ channels: {} }),
      accountId: "default",
      input: {
        projectId: "project",
        secret: "secret",
        webhookSecret: "signing",
        webhookBaseUrl: "https://imessage.example.com",
      } as any,
    });

    expect(next.channels?.["imessage-spectrum"]).toMatchObject({
      enabled: true,
      projectId: "project",
      projectSecret: "secret",
      webhookSecret: "signing",
      webhookBaseUrl: "https://imessage.example.com",
    });
  });

  it("accepts the documented projectSecret setup field", () => {
    const next = spectrumSetupAdapter.applyAccountConfig({
      cfg: asConfig({ channels: {} }),
      accountId: "default",
      input: {
        projectId: "project",
        projectSecret: "secret",
      } as any,
    });

    expect(next.channels?.["imessage-spectrum"]).toMatchObject({
      enabled: true,
      projectId: "project",
      projectSecret: "secret",
    });
  });

  it("applies setup fields to named account config", () => {
    const next = spectrumSetupAdapter.applyAccountConfig({
      cfg: asConfig({ channels: {} }),
      accountId: "support",
      input: {
        projectId: "project",
        secret: "secret",
        webhookBaseUrl: "https://support.example.com",
      } as any,
    });

    expect(next.channels?.["imessage-spectrum"]).toMatchObject({
      enabled: true,
      accounts: {
        support: {
          enabled: true,
          projectId: "project",
          projectSecret: "secret",
          webhookBaseUrl: "https://support.example.com",
        },
      },
    });
  });
});

describe("buildSpectrumWebhookRegistrationCurl", () => {
  it("uses the real project ID and webhook URL without echoing the project secret", () => {
    const command = buildSpectrumWebhookRegistrationCurl({
      projectId: "project_123",
      webhookBaseUrl: "https://gateway.example.com/",
    });

    expect(command).toContain("SPECTRUM_PROJECT_ID='project_123'");
    expect(command).toContain(
      '"webhookUrl":"https://gateway.example.com/channels/imessage-spectrum/webhook"',
    );
    expect(command).toContain("SPECTRUM_PROJECT_SECRET='<paste-project-secret>'");
    expect(command).not.toContain("project-secret-value");
  });
});

describe("imessageSpectrumSetupPlugin.setupWizard", () => {
  it("shows the webhook registration curl after project credentials are entered", async () => {
    const note = vi.fn<WizardPrompter["note"]>().mockResolvedValue(undefined);
    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("project_123")
      .mockResolvedValueOnce("project-secret-value")
      .mockResolvedValueOnce("https://gateway.example.com/")
      .mockResolvedValueOnce("signing-secret");

    const prompter = {
      note,
      text,
    } as unknown as WizardPrompter;

    const setupWizard = imessageSpectrumSetupPlugin.setupWizard as ChannelSetupWizard;
    const result = await setupWizard.finalize?.({
      cfg: asConfig({ channels: {} }),
      accountId: "default",
      credentialValues: {},
      runtime: undefined as never,
      prompter,
      forceAllowFrom: false,
    });

    expect(text.mock.calls[1]?.[0]).toMatchObject({ sensitive: true });
    expect(text.mock.calls[3]?.[0]).toMatchObject({ sensitive: true });

    const webhookNote = note.mock.calls.find((call) => call[1] === "Photon webhook")?.[0] ?? "";
    expect(webhookNote).toContain("SPECTRUM_PROJECT_ID='project_123'");
    expect(webhookNote).toContain("https://gateway.example.com/channels/imessage-spectrum/webhook");
    expect(webhookNote).not.toContain("project-secret-value");
    expect(result?.cfg?.channels?.["imessage-spectrum"]).toMatchObject({
      projectId: "project_123",
      projectSecret: "project-secret-value",
      webhookBaseUrl: "https://gateway.example.com",
      webhookSecret: "signing-secret",
    });
  });
});
