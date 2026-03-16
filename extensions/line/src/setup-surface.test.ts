import type { OpenClawConfig } from "openclaw/plugin-sdk/line";
import { describe, expect, it, vi } from "vitest";
import { buildChannelSetupFlowAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../../src/line/accounts.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import { lineSetupAdapter, lineSetupWizard } from "./setup-surface.js";

function createPrompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async ({ options }: { options: Array<{ value: string }> }) => {
      const first = options[0];
      if (!first) {
        throw new Error("no options");
      }
      return first.value;
    }) as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "") as WizardPrompter["text"],
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}

const lineConfigureAdapter = buildChannelSetupFlowAdapterFromSetupWizard({
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
  } as Parameters<typeof buildChannelSetupFlowAdapterFromSetupWizard>[0]["plugin"],
  wizard: lineSetupWizard,
});

describe("line setup wizard", () => {
  it("configures token and secret for the default account", async () => {
    const prompter = createPrompter({
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
});
