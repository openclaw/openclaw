import {
  createSetupWizardAdapter,
  createQueuedWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { inspectMattermostAccount, isMattermostConfigured } from "./mattermost/accounts.js";
import { mattermostSetupAdapter } from "./setup-core.js";
import { mattermostSetupWizard } from "./setup-surface.js";
import type { MattermostConfig } from "./types.js";

const normalizeMattermostBaseUrl = vi.hoisted(() => vi.fn((value: string | undefined) => value));
// mock-isolation: Setup validation owns URL decisions without creating a live Mattermost client.
vi.mock("./mattermost/client.js", () => ({ normalizeMattermostBaseUrl }));

const baseUrl = "https://chat.example.com";
const secretToken = { source: "env", provider: "default", id: "MATTERMOST_BOT_TOKEN" } as const;
const config = (mattermost: MattermostConfig = {}): OpenClawConfig => ({
  channels: { mattermost },
});
const wizardConfigured = (mattermost: MattermostConfig) =>
  mattermostSetupWizard.status.resolveConfigured({ cfg: config(mattermost) });

describe("mattermost setup", () => {
  afterEach(() => {
    normalizeMattermostBaseUrl.mockReset().mockImplementation((value: string | undefined) => value);
    vi.unstubAllEnvs();
  });

  it("reports configuration with and without credential status metadata", () => {
    const account = inspectMattermostAccount({ cfg: config({ botToken: "bot-token", baseUrl }) });
    const configured = (overrides: Partial<typeof account>) =>
      isMattermostConfigured({ ...account, ...overrides });
    expect(configured({ botTokenStatus: undefined })).toBe(true);
    expect(configured({ botToken: "", botTokenStatus: "configured_unavailable" })).toBe(true);
    expect(configured({ botToken: "", botTokenStatus: undefined, baseUrl: "" })).toBe(false);
  });

  it("validates env and explicit credential requirements", () => {
    const validateInput = mattermostSetupAdapter.validateInput;
    if (!validateInput) {
      throw new Error("Expected Mattermost setup validateInput");
    }
    const validate = (
      input: Parameters<typeof validateInput>[0]["input"],
      accountId = DEFAULT_ACCOUNT_ID,
    ) => validateInput({ cfg: config(), accountId, input });
    expect(validate({ useEnv: true }, "secondary")).toBe(
      "Mattermost env vars can only be used for the default account.",
    );
    normalizeMattermostBaseUrl.mockReturnValue(undefined);
    expect(validate({ useEnv: false, botToken: "tok", httpUrl: "not-a-url" })).toBe(
      "Mattermost requires --bot-token and --http-url (or --use-env).",
    );
    normalizeMattermostBaseUrl.mockReturnValue(baseUrl);
    expect(validate({ useEnv: false, botToken: "tok", httpUrl: baseUrl })).toBeNull();
  });

  it("applies normalized config for default and named accounts", () => {
    normalizeMattermostBaseUrl.mockReturnValue(baseUrl);
    const applyAccountConfig = mattermostSetupAdapter.applyAccountConfig;
    const apply = (cfg: OpenClawConfig, accountId: string, name: string, botToken: string) =>
      applyAccountConfig({ cfg, accountId, input: { name, botToken, httpUrl: baseUrl } });
    expect(apply(config(), DEFAULT_ACCOUNT_ID, "Default", "tok")).toEqual(
      config({ enabled: true, name: "Default", botToken: "tok", baseUrl }),
    );
    expect(apply(config({ name: "Legacy" }), "Work Team", "Work", "tok2")).toEqual(
      config({
        enabled: true,
        accounts: {
          default: { name: "Legacy" },
          "work-team": { enabled: true, name: "Work", botToken: "tok2", baseUrl },
        },
      }),
    );
  });

  it("treats secret-ref tokens plus base url as configured", async () => {
    expect(await wizardConfigured({ baseUrl, botToken: secretToken })).toBe(true);
  });

  it("does not inherit configured state from a sibling when defaultAccount is named", async () => {
    const accounts = { alerts: { baseUrl, botToken: secretToken }, work: {} };
    expect(await wizardConfigured({ defaultAccount: "work", accounts })).toBe(false);
  });

  it("offers env shortcut only for the default account when env is present and config is empty", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "bot-token");
    vi.stubEnv("MATTERMOST_URL", baseUrl);
    const isAvailable = (accountId: string) =>
      mattermostSetupWizard.envShortcut?.isAvailable?.({ cfg: config(), accountId } as never);
    expect(isAvailable("default")).toBe(true);
    expect(isAvailable("work")).toBe(false);
  });

  it("keeps env shortcut as a no-op patch for the selected account", () => {
    const params = { cfg: config({ enabled: false }), accountId: "default" };
    expect(mattermostSetupWizard.envShortcut?.apply?.(params as never)).toEqual(
      config({ enabled: true }),
    );
  });

  it("prompts for bot token and server URL before validating wizard setup", async () => {
    normalizeMattermostBaseUrl.mockImplementation((value: string | undefined) =>
      value?.startsWith("http") ? value : undefined,
    );
    const queued = createQueuedWizardPrompter({ textValues: ["bot-token", baseUrl] });
    const adapter = createSetupWizardAdapter({
      plugin: {
        id: "mattermost",
        meta: { label: "Mattermost" },
        config: { listAccountIds: () => [DEFAULT_ACCOUNT_ID] },
        setup: mattermostSetupAdapter,
      } as never,
      wizard: mattermostSetupWizard,
    });
    const result = await runSetupWizardConfigure({
      configure: adapter.configure,
      cfg: config(),
      prompter: queued.prompter,
      options: { secretInputMode: "plaintext" as const },
    });
    const textMessages = queued.text.mock.calls.map(
      ([params]) => (params as { message: string }).message,
    );
    expect(textMessages).toEqual(["Enter Mattermost bot token", "Enter Mattermost base URL"]);
    expect(result.cfg.channels?.mattermost).toMatchObject({ botToken: "bot-token", baseUrl });
    expect(result.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });
});
