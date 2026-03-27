import type { WebClient } from "@slack/web-api";
import { vi } from "vitest";

export type SlackEditTestClient = WebClient & {
  chat: {
    update: ReturnType<typeof vi.fn>;
  };
};

export type SlackSendTestClient = WebClient & {
  conversations: {
    open: ReturnType<typeof vi.fn>;
  };
  chat: {
    postMessage: ReturnType<typeof vi.fn>;
  };
};

const slackBlockTestState = vi.hoisted(() => ({
  account: {
    accountId: "default",
    botToken: "xoxb-test",
    botTokenSource: "config",
    config: {},
  },
  config: {},
}));

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig: () => slackBlockTestState.config,
  };
});

// The channel plugin registry isn't initialized in unit tests, so
// normalizeChannelId("slack") returns null and resolveMarkdownTableMode
// falls back to "code" instead of Slack's default "block".
// We mock the channels registry to recognise "slack" without full plugin init.


vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return {
    ...actual,
    resolveSlackAccount: () => slackBlockTestState.account,
  };
});

// Kept for compatibility with existing tests; mocks install at module evaluation.
export function installSlackBlockTestMocks() {
  return;
}

/** Override the mock config for a test (e.g. to set tableMode). */
export function setBlockTestConfig(config: Record<string, unknown>) {
  slackBlockTestState.config = config as never;
}

export function createSlackEditTestClient(): SlackEditTestClient {
  return {
    chat: {
      update: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as SlackEditTestClient;
}

export function createSlackSendTestClient(): SlackSendTestClient {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D123" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
  } as unknown as SlackSendTestClient;
}
