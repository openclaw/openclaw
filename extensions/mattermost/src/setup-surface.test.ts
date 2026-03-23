import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { mattermostSetupWizard } from "./setup-surface.js";

describe("mattermost setup surface", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats secret-ref tokens plus base url as configured", async () => {
    const configured = await mattermostSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          mattermost: {
            baseUrl: "https://chat.example.com",
            botToken: {
              source: "env",
              provider: "default",
              id: "MATTERMOST_BOT_TOKEN",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(true);
  });

  it("shows intro note only when the target account is not configured", () => {
    expect(
      mattermostSetupWizard.introNote?.shouldShow?.({
        cfg: {
          channels: {
            mattermost: {},
          },
        } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toBe(true);

    expect(
      mattermostSetupWizard.introNote?.shouldShow?.({
        cfg: {
          channels: {
            mattermost: {
              baseUrl: "https://chat.example.com",
              botToken: {
                source: "env",
                provider: "default",
                id: "MATTERMOST_BOT_TOKEN",
              },
            },
          },
        } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toBe(false);
  });

  it("offers env shortcut only for the default account when env is present and config is empty", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "bot-token");
    vi.stubEnv("MATTERMOST_URL", "https://chat.example.com");

    expect(
      mattermostSetupWizard.envShortcut?.isAvailable?.({
        cfg: { channels: { mattermost: {} } } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toBe(true);

    expect(
      mattermostSetupWizard.envShortcut?.isAvailable?.({
        cfg: { channels: { mattermost: {} } } as OpenClawConfig,
        accountId: "work",
      } as never),
    ).toBe(false);
  });

  it("keeps env shortcut as a no-op patch for the selected account", () => {
    expect(
      mattermostSetupWizard.envShortcut?.apply?.({
        cfg: { channels: { mattermost: { enabled: false } } } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toEqual({
      channels: {
        mattermost: {
          enabled: true,
        },
      },
    });
  });
});
