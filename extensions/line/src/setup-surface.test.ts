import { describe, expect, it, vi } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../../src/line/accounts.js";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import {
  createTestWizardPrompter,
  type WizardPrompter,
} from "../../../test/helpers/extensions/setup-wizard.js";
import type { OpenClawConfig } from "../api.js";
import { lineSetupAdapter, lineSetupWizard } from "./setup-surface.js";

const lineConfigureAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: {
    id: "line",
    meta: { label: "LINE" },
    config: {
      listAccountIds: listLineAccountIds,
      defaultAccountId: resolveDefaultLineAccountId,
      resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
        resolveLineAccount({ cfg, accountId: accountId ?? undefined }).config.allowFrom,
    },
    setup: lineSetupAdapter,
  } as Parameters<typeof buildChannelSetupWizardAdapterFromSetupWizard>[0]["plugin"],
  wizard: lineSetupWizard,
});

describe("line setup wizard", () => {
  it("configures token and secret for the default account", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter LINE channel access token") {
          return "line-token";
        }
        if (message === "Enter LINE channel secret") {
          return "line-secret";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await lineConfigureAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime: createRuntimeEnv(),
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.line?.enabled).toBe(true);
    expect(result.cfg.channels?.line?.channelAccessToken).toBe("line-token");
    expect(result.cfg.channels?.line?.channelSecret).toBe("line-secret");
  });

  it("re-enables and refreshes accounts.default when rerunning default account setup", () => {
    const next = lineSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          line: {
            enabled: true,
            accounts: {
              default: {
                enabled: false,
                channelAccessToken: "stale-token",
                channelSecret: "stale-secret",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      input: {
        channelAccessToken: "fresh-token",
        channelSecret: "fresh-secret",
      },
    });

    expect(next.channels?.line?.enabled).toBe(true);
    expect(next.channels?.line?.accounts?.default?.enabled).toBe(true);
    expect(next.channels?.line?.accounts?.default?.channelAccessToken).toBe("fresh-token");
    expect(next.channels?.line?.accounts?.default?.channelSecret).toBe("fresh-secret");

    const resolved = resolveLineAccount({ cfg: next, accountId: "default" });
    expect(resolved.enabled).toBe(true);
    expect(resolved.channelAccessToken).toBe("fresh-token");
    expect(resolved.channelSecret).toBe("fresh-secret");
  });
});
