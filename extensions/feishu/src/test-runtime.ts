import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { setFeishuRuntime } from "./runtime.js";

/**
 * Set a minimal mock runtime for feishu tests.
 * Call in beforeEach of tests that need resolveFeishuAccount, listFeishuAccountIds, etc.
 */
export function setupFeishuTestRuntime(cfgOverride?: ClawdbotConfig) {
  const feishuCfg = cfgOverride?.channels?.feishu as Record<string, unknown> | undefined;
  const accounts = (feishuCfg?.accounts as Record<string, unknown>) ?? {};
  const ids = Object.keys(accounts).filter(Boolean);
  const accountIds = ids.length > 0 ? ids : ["default"];

  setFeishuRuntime({
    version: "test",
    config: {},
    system: {},
    media: {},
    tts: {},
    tools: {},
    channel: {
      feishu: {
        listFeishuAccountIds: () => accountIds,
        resolveDefaultFeishuAccountId: () => accountIds[0] ?? "default",
        resolveFeishuAccount: ({ cfg, accountId }: { cfg: ClawdbotConfig; accountId?: string }) => {
          const fc = cfg?.channels?.feishu as Record<string, unknown> | undefined;
          const accts = (fc?.accounts as Record<string, Record<string, unknown>>) ?? {};
          const id = accountId ?? "default";
          const acct = accts[id] ?? {};
          const merged = { ...fc, ...acct } as Record<string, unknown>;
          const appId = (merged.appId as string) ?? (acct.appId as string);
          const appSecret = (merged.appSecret as string) ?? (acct.appSecret as string);
          return {
            accountId: id,
            enabled: true,
            configured: Boolean(appId && appSecret),
            appId,
            appSecret,
            domain: "feishu" as const,
            config: merged,
          };
        },
        probeFeishu: async (creds?: unknown) => ({
          ok: true,
          appId: (creds as { appId?: string })?.appId,
        }),
        sendMessageFeishu: async () => ({ messageId: "", chatId: "" }),
        getMessageFeishu: async () => null,
        sendCardFeishu: async () => ({ messageId: "", chatId: "" }),
        sendMarkdownCardFeishu: async () => ({ messageId: "", chatId: "" }),
        updateCardFeishu: async () => {},
        editMessageFeishu: async () => {},
        buildMarkdownCard: (t: string) => ({
          body: { elements: [{ tag: "markdown", content: t }] },
        }),
        clearProbeCache: () => {},
      },
      text: { resolveMarkdownTableMode: () => "native", convertMarkdownTables: (t: string) => t },
    },
    logging: {},
    state: {},
  } as never);
}
