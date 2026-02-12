/**
 * Configuration fixtures for DingTalk account testing.
 */

import type { ResolvedDingTalkAccount } from "../../src/accounts.js";
import { DINGTALK_CHANNEL_ID } from "../../src/config-schema.js";

/**
 * Minimal valid account configuration.
 */
export const BASIC_ACCOUNT: ResolvedDingTalkAccount = {
  accountId: "default",
  enabled: true,
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  credentialSource: "config",
  apiBase: "https://api.dingtalk.com",
  openPath: "/v1.0/gateway/connections/open",
  replyMode: "text",
  maxChars: 1800,
  tableMode: "code",
  coalesce: {
    enabled: false,
    minChars: 100,
    maxChars: 1000,
    idleMs: 500,
  },
  allowFrom: [],
  requireMention: true,
  isolateContextPerUserInGroup: false,
  mentionBypassUsers: [],
  showToolStatus: false,
  showToolResult: false,
  thinking: "off",
};

/**
 * Account with markdown reply mode.
 */
export const MARKDOWN_ACCOUNT: ResolvedDingTalkAccount = {
  ...BASIC_ACCOUNT,
  accountId: "markdown",
  replyMode: "markdown",
};

/**
 * Account with allowlist filtering.
 */
export const FILTERED_ACCOUNT: ResolvedDingTalkAccount = {
  ...BASIC_ACCOUNT,
  accountId: "filtered",
  allowFrom: ["allowed-user-1", "allowed-user-2"],
  selfUserId: "bot-user-id",
};

/**
 * Account with prefix requirement.
 */
export const PREFIX_ACCOUNT: ResolvedDingTalkAccount = {
  ...BASIC_ACCOUNT,
  accountId: "prefixed",
  requirePrefix: "@bot",
};

/**
 * Account with @mention requirement disabled.
 */
export const NO_MENTION_ACCOUNT: ResolvedDingTalkAccount = {
  ...BASIC_ACCOUNT,
  accountId: "no-mention",
  requireMention: false,
};

/**
 * Account with @mention bypass users.
 */
export const MENTION_BYPASS_ACCOUNT: ResolvedDingTalkAccount = {
  ...BASIC_ACCOUNT,
  accountId: "mention-bypass",
  requireMention: true,
  mentionBypassUsers: ["admin-user-1", "vip-user-2"],
};

/**
 * Account with response prefix.
 */
export const RESPONSE_PREFIX_ACCOUNT: ResolvedDingTalkAccount = {
  ...BASIC_ACCOUNT,
  accountId: "response-prefix",
  responsePrefix: "[{model}]",
};

/**
 * Account with verbose tool status enabled.
 */
export const VERBOSE_ACCOUNT: ResolvedDingTalkAccount = {
  ...BASIC_ACCOUNT,
  accountId: "verbose",
  showToolStatus: true,
  showToolResult: true,
};

/**
 * Account without credentials (for error testing).
 */
export const UNCONFIGURED_ACCOUNT: ResolvedDingTalkAccount = {
  ...BASIC_ACCOUNT,
  accountId: "unconfigured",
  clientId: "",
  clientSecret: "",
  credentialSource: "none",
};

/**
 * Mock OpenClaw config for testing.
 */
export function createMockClawdbotConfig(dingtalkOverrides: Record<string, unknown> = {}) {
  return {
    channels: {
      [DINGTALK_CHANNEL_ID]: {
        enabled: true,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        ...dingtalkOverrides,
      },
    },
  };
}

/**
 * Mock ClawdbotConfig with environment-based credentials.
 */
export function createEnvBasedConfig() {
  return {
    channels: {
      [DINGTALK_CHANNEL_ID]: {
        enabled: true,
      },
    },
  };
}

/**
 * Mock ClawdbotConfig with multiple accounts.
 */
export function createMultiAccountConfig() {
  return {
    channels: {
      [DINGTALK_CHANNEL_ID]: {
        enabled: true,
        clientId: "default-client-id",
        clientSecret: "default-client-secret",
        accounts: {
          team1: {
            name: "Team 1 Bot",
            clientId: "team1-client-id",
            clientSecret: "team1-client-secret",
          },
          team2: {
            name: "Team 2 Bot",
            clientId: "team2-client-id",
            clientSecret: "team2-client-secret",
            replyMode: "markdown",
          },
        },
      },
    },
  };
}
