import { describe, expect, it } from "vitest";
import { createCodexAppServerBindingStore, sessionBindingIdentity } from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";
import { retireCodexAppServerSessionGeneration } from "./session-retirement.js";

describe("Codex conversation bindings across session retirement", () => {
  it("keeps explicit Telegram topic bindings independent across /new and restart", async () => {
    const stateStore = createCodexTestBindingStateStore();
    const bindingStore = createCodexAppServerBindingStore(stateStore);
    const resetSession = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "telegram-session-77",
      sessionKey: "agent:worker:telegram:group:-1001:topic:77",
    });
    const conversations = [77, 88].map((topic) => ({
      kind: "conversation" as const,
      bindingId: `telegram-binding-${topic}`,
    }));
    expect(bindingStore.read(resetSession)).toBeUndefined();
    await bindingStore.mutate(conversations[0]!, {
      kind: "set",
      binding: { threadId: "telegram-binding-77-thread", cwd: "/repo" },
    });

    // The /new session_end hook retires this absent session generation, while
    // explicit /codex bind conversation identities remain independent owners.
    await expect(
      retireCodexAppServerSessionGeneration({
        bindingStore,
        identity: resetSession,
        mode: "retire",
      }),
    ).resolves.toBe("absent");

    const restartedStore = createCodexAppServerBindingStore(stateStore);
    expect(restartedStore.read(resetSession)).toBeUndefined();
    expect(conversations.map((identity) => restartedStore.read(identity)?.threadId)).toEqual([
      "telegram-binding-77-thread",
      undefined,
    ]);
  });
});
