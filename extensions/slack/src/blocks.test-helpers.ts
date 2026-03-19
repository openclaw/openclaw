import type { WebClient } from "@slack/web-api";
import { vi } from "vitest";

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("./accounts.js", () => ({
  resolveSlackAccount: () => ({
    accountId: "default",
    botToken: "xoxb-test",
    botTokenSource: "config",
    config: {},
  }),
}));

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

export function installSlackBlockTestMocks() {
  // Backward compatible no-op. Mocks are hoisted at module scope.
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
