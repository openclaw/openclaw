import { afterEach, describe, expect, it } from "vitest";
import { createPluginRuntime } from "../../../src/plugins/runtime/index.js";
import { clearWempRuntime, dispatchToAgent, setWempRuntime, trySetWempRuntime } from "./runtime.js";

function rememberEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  clearWempRuntime();
});

describe("wemp runtime", () => {
  it("core runtime exposes channel.dispatchInbound", () => {
    const runtime = createPluginRuntime();
    expect(typeof runtime.channel.dispatchInbound).toBe("function");
  });

  it("dispatchToAgent builds expected payload and sessionKey", async () => {
    let captured: Record<string, unknown> | null = null;
    setWempRuntime({
      channel: {
        dispatchInbound: async (payload: Record<string, unknown>) => {
          captured = payload;
        },
      },
    } as any);

    const result = await dispatchToAgent({
      channel: "wemp",
      accountId: "acc-1",
      openId: "open-1",
      agentId: "main",
      text: "hello",
      messageId: "m-1",
    });

    expect(result.accepted).toBe(true);
    expect(result.sessionKey).toBe("agent:main:wemp:acc-1:dm:open-1");
    expect(captured).toBeTruthy();
    expect(captured?.["sessionKey"]).toBe("agent:main:wemp:acc-1:dm:open-1");
    expect(captured?.["chatType"]).toBe("direct");
    expect(captured?.["targetAgentId"]).toBe("main");
  });

  it("dispatchToAgent supports runtime chatType and sessionKey template overrides", async () => {
    const previousTemplate = process.env.WEMP_RUNTIME_SESSION_KEY_TEMPLATE;
    const previousChatType = process.env.WEMP_RUNTIME_CHAT_TYPE;
    process.env.WEMP_RUNTIME_SESSION_KEY_TEMPLATE = "sess:{accountId}:{openId}:{agentId}";
    process.env.WEMP_RUNTIME_CHAT_TYPE = "group";

    let captured: Record<string, unknown> | null = null;
    setWempRuntime({
      channel: {
        dispatchInbound: async (payload: Record<string, unknown>) => {
          captured = payload;
        },
      },
    } as any);

    try {
      const result = await dispatchToAgent({
        channel: "wemp",
        accountId: "acc-x",
        openId: "open-y",
        agentId: "agent-z",
        text: "hello",
      });

      expect(result.accepted).toBe(true);
      expect(result.sessionKey).toBe("sess:acc-x:open-y:agent-z");
      expect(captured?.["sessionKey"]).toBe("sess:acc-x:open-y:agent-z");
      expect(captured?.["chatType"]).toBe("group");
    } finally {
      if (previousTemplate === undefined) delete process.env.WEMP_RUNTIME_SESSION_KEY_TEMPLATE;
      else process.env.WEMP_RUNTIME_SESSION_KEY_TEMPLATE = previousTemplate;
      if (previousChatType === undefined) delete process.env.WEMP_RUNTIME_CHAT_TYPE;
      else process.env.WEMP_RUNTIME_CHAT_TYPE = previousChatType;
    }
  });

  it("dispatchToAgent rejects invalid chatType when runtime validation is enabled", async () => {
    const envSnapshot = rememberEnv([
      "WEMP_RUNTIME_VALIDATE",
      "WEMP_RUNTIME_CHAT_TYPE",
      "WEMP_RUNTIME_SESSION_KEY_TEMPLATE",
    ]);
    process.env.WEMP_RUNTIME_VALIDATE = "1";
    process.env.WEMP_RUNTIME_CHAT_TYPE = "room";
    delete process.env.WEMP_RUNTIME_SESSION_KEY_TEMPLATE;

    let dispatchCalls = 0;
    setWempRuntime({
      channel: {
        dispatchInbound: async () => {
          dispatchCalls += 1;
        },
      },
    } as any);

    try {
      const result = await dispatchToAgent({
        channel: "wemp",
        accountId: "acc-v",
        openId: "open-v",
        agentId: "agent-v",
        text: "hello",
      });

      expect(result.accepted).toBe(false);
      expect(result.note || "").toMatch(/chatType/i);
      expect(dispatchCalls).toBe(0);
    } finally {
      restoreEnv(envSnapshot);
    }
  });

  it("dispatchToAgent rejects invalid sessionKey template when runtime validation is enabled", async () => {
    const envSnapshot = rememberEnv([
      "WEMP_RUNTIME_VALIDATE",
      "WEMP_RUNTIME_CHAT_TYPE",
      "WEMP_RUNTIME_SESSION_KEY_TEMPLATE",
    ]);
    process.env.WEMP_RUNTIME_VALIDATE = "1";
    process.env.WEMP_RUNTIME_CHAT_TYPE = "direct";
    process.env.WEMP_RUNTIME_SESSION_KEY_TEMPLATE = "sess:{accountId}:{openId}";

    let dispatchCalls = 0;
    setWempRuntime({
      channel: {
        dispatchInbound: async () => {
          dispatchCalls += 1;
        },
      },
    } as any);

    try {
      const result = await dispatchToAgent({
        channel: "wemp",
        accountId: "acc-v2",
        openId: "open-v2",
        agentId: "agent-v2",
        text: "hello",
      });

      expect(result.accepted).toBe(false);
      expect(result.note || "").toMatch(/template/i);
      expect(dispatchCalls).toBe(0);
    } finally {
      restoreEnv(envSnapshot);
    }
  });

  it("dispatchToAgent rejects sessionKey over max length", async () => {
    const envSnapshot = rememberEnv([
      "WEMP_RUNTIME_VALIDATE",
      "WEMP_RUNTIME_SESSION_KEY_MAX_LEN",
      "WEMP_RUNTIME_SESSION_KEY_TEMPLATE",
      "WEMP_RUNTIME_CHAT_TYPE",
    ]);
    delete process.env.WEMP_RUNTIME_VALIDATE;
    process.env.WEMP_RUNTIME_SESSION_KEY_MAX_LEN = "12";
    process.env.WEMP_RUNTIME_SESSION_KEY_TEMPLATE = "sess:{agentId}:{channel}:{accountId}:{openId}";
    delete process.env.WEMP_RUNTIME_CHAT_TYPE;

    let dispatchCalls = 0;
    setWempRuntime({
      channel: {
        dispatchInbound: async () => {
          dispatchCalls += 1;
        },
      },
    } as any);

    try {
      const result = await dispatchToAgent({
        channel: "wemp",
        accountId: "acc-long",
        openId: "open-long",
        agentId: "agent-long",
        text: "hello",
      });

      expect(result.accepted).toBe(false);
      expect(result.note || "").toMatch(/exceeds max 12/i);
      expect(dispatchCalls).toBe(0);
    } finally {
      restoreEnv(envSnapshot);
    }
  });

  it("trySetWempRuntime supports direct dispatchInbound shape", async () => {
    let count = 0;
    const ok = trySetWempRuntime({
      dispatchInbound: async () => {
        count += 1;
      },
    });
    expect(ok).toBe(true);
    await dispatchToAgent({
      channel: "wemp",
      accountId: "acc-2",
      openId: "open-2",
      agentId: "wemp-kf",
      text: "hi",
    });
    expect(count).toBe(1);
  });

  it("setWempRuntime supports top-level dispatchInbound compatibility shape", async () => {
    let count = 0;
    setWempRuntime({
      dispatchInbound: async () => {
        count += 1;
      },
    } as any);
    const result = await dispatchToAgent({
      channel: "wemp",
      accountId: "acc-compat",
      openId: "open-compat",
      agentId: "main",
      text: "hello",
    });
    expect(result.accepted).toBe(true);
    expect(count).toBe(1);
  });

  it("dispatchToAgent throws when runtime missing", async () => {
    clearWempRuntime();
    await expect(
      dispatchToAgent({
        channel: "wemp",
        accountId: "acc-3",
        openId: "open-3",
        agentId: "main",
        text: "x",
      }),
    ).rejects.toThrow();
  });
});
