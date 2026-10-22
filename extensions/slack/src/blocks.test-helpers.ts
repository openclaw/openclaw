// Slack helper module supports blocks helpers behavior.
import type { WebClient } from "@slack/web-api";
import { vi } from "vitest";

type SlackEditTestClient = WebClient & {
  chat: {
    update: ReturnType<typeof vi.fn>;
  };
};

type SlackSendTestClient = WebClient & {
  conversations: {
    open: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
    replies: ReturnType<typeof vi.fn>;
  };
  chat: {
    postMessage: ReturnType<typeof vi.fn>;
  };
};

const slackBlockTestState = vi.hoisted(() => ({
  parentConversations: {
    history: vi.fn(async ({ latest }: { latest: string }) => ({
      ok: true,
      messages: [{ ts: latest }],
    })),
    replies: vi.fn(async () => ({ ok: true, messages: [] })),
  },
  account: {
    accountId: "default",
    botToken: "xoxb-test",
    botTokenSource: "config",
    config: {},
  },
  config: {},
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createSlackLookupClient: () => ({ conversations: slackBlockTestState.parentConversations }),
}));

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return {
    ...actual,
    resolveSlackAccount: () => slackBlockTestState.account,
  };
});

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
      ...slackBlockTestState.parentConversations,
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
  } as unknown as SlackSendTestClient;
}
