import { vi } from "vitest";
function installSlackBlockTestMocks() {
  vi.mock("../../../src/config/config.js", () => ({
    loadConfig: () => ({})
  }));
  vi.mock("./accounts.js", () => ({
    resolveSlackAccount: () => ({
      accountId: "default",
      botToken: "xoxb-test",
      botTokenSource: "config",
      config: {}
    })
  }));
}
function createSlackEditTestClient() {
  return {
    chat: {
      update: vi.fn(async () => ({ ok: true }))
    }
  };
}
function createSlackSendTestClient() {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D123" } }))
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" }))
    }
  };
}
export {
  createSlackEditTestClient,
  createSlackSendTestClient,
  installSlackBlockTestMocks
};
