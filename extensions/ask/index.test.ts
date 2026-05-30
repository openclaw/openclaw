import { describe, expect, it, vi } from "vitest";
import { classifyAskInput } from "./classifier.js";
import { buildAskDiscordComponents } from "./components.js";
import askPlugin from "./index.js";
import { createAskInteractiveHandler } from "./interactive-handler.js";
import type { AskStores } from "./session-store.js";
import type { AskSession } from "./types.js";

function createMemoryStore<T>() {
  const map = new Map<string, T>();
  return {
    register: vi.fn(async (key: string, value: T) => {
      map.set(key, value);
    }),
    registerIfAbsent: vi.fn(async (key: string, value: T) => {
      if (map.has(key)) {
        return false;
      }
      map.set(key, value);
      return true;
    }),
    lookup: vi.fn(async (key: string) => map.get(key)),
    consume: vi.fn(async (key: string) => {
      const value = map.get(key);
      map.delete(key);
      return value;
    }),
    delete: vi.fn(async (key: string) => map.delete(key)),
    entries: vi.fn(async () =>
      [...map.entries()].map(([key, value]) => ({ key, value, createdAt: Date.now() })),
    ),
    clear: vi.fn(async () => map.clear()),
    map,
  };
}

function createSession(overrides: Partial<AskSession> = {}): AskSession {
  const now = Date.now();
  return {
    askId: "ask_test",
    mode: "single",
    createdAt: now,
    expiresAt: now + 60_000,
    requesterUserId: "u1",
    sourceChannel: "discord",
    questionText: "GO?",
    uiType: "button",
    options: [
      { label: "GO", value: "go" },
      { label: "STOP", value: "stop" },
    ],
    allowedUsers: ["u1"],
    reusable: false,
    status: "open",
    nextActionPolicy: "log_only",
    requiresSecondGo: true,
    actionScope: "answer_capture_only",
    ...overrides,
  };
}

describe("ask classifier", () => {
  it("uses buttons for GO/STOP", () => {
    expect(classifyAskInput("実装GOでいい？")).toMatchObject({
      uiType: "button",
      options: [
        { label: "GO", value: "go" },
        { label: "STOP", value: "stop" },
      ],
    });
  });

  it("uses modal for reason prompts", () => {
    expect(classifyAskInput("違和感と理由を教えて").uiType).toBe("modal");
  });

  it("uses select for explicit long option lists", () => {
    expect(classifyAskInput("方向性を選んで --options=a,b,c,d,e,f").uiType).toBe("select");
  });

  it("detects grill mode from the input prefix", () => {
    expect(classifyAskInput("grill 曖昧な依頼を仕様にしたい")).toMatchObject({
      mode: "grill",
      uiType: "modal",
      questionText: "曖昧な依頼を仕様にしたい",
    });
  });
});

describe("ask Discord components", () => {
  it("builds button callback data and log-only note", () => {
    const spec = buildAskDiscordComponents(createSession());
    expect(spec.reusable).toBe(false);
    expect(spec.text).toContain("別GO");
    expect(spec.blocks?.[0]).toMatchObject({
      type: "actions",
      buttons: [
        { label: "GO", callbackData: "ask:ask_test:go", allowedUsers: ["u1"] },
        { label: "STOP", callbackData: "ask:ask_test:stop", allowedUsers: ["u1"] },
      ],
    });
  });

  it("builds grill mode as a one-question modal", () => {
    const spec = buildAskDiscordComponents(
      createSession({
        mode: "grill",
        questionText: "この依頼で最終的に何が変われば成功ですか？",
        uiType: "modal",
        options: [],
        grill: {
          initialRequest: "曖昧な依頼を仕様にしたい",
          currentStepIndex: 0,
          answers: [],
        },
      }),
    );
    expect(spec.text).toContain("**/ask grill** Goal (1/6)");
    expect(spec.modal?.triggerLabel).toBe("この質問に答える");
  });
});

describe("ask plugin registration", () => {
  it("scopes the command to Discord", () => {
    const registerCommand = vi.fn();
    const registerInteractiveHandler = vi.fn();
    askPlugin.register({
      registerCommand,
      registerInteractiveHandler,
      runtime: { state: { openKeyedStore: vi.fn(() => createMemoryStore<unknown>()) } },
    } as never);

    expect(registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ask",
        channels: ["discord"],
      }),
    );
  });
});

describe("ask interactive handler", () => {
  it("accepts the allowed actor once and stores the answer", async () => {
    const sessions = createMemoryStore<AskSession>();
    const feedback = createMemoryStore<never>();
    const stores = { sessions, feedback } as unknown as AskStores;
    await sessions.register("ask_test", createSession());
    const clearComponents = vi.fn();
    const handler = createAskInteractiveHandler(stores);

    await handler({
      channel: "discord",
      accountId: "default",
      interactionId: "i1",
      conversationId: "channel:c1",
      senderId: "u1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: "ask:ask_test:go",
        namespace: "ask",
        payload: "ask_test:go",
        messageId: "m1",
      },
      respond: {
        acknowledge: vi.fn(),
        reply: vi.fn(),
        followUp: vi.fn(),
        editMessage: vi.fn(),
        clearComponents,
      },
      requestConversationBinding: vi.fn(),
      detachConversationBinding: vi.fn(),
      getCurrentConversationBinding: vi.fn(),
    });

    expect((await sessions.lookup("ask_test"))?.status).toBe("answered");
    expect((await sessions.lookup("ask_test"))?.result?.values).toEqual(["go"]);
    expect(clearComponents).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("別GO") }),
    );
  });

  it("rejects unauthorized actors", async () => {
    const sessions = createMemoryStore<AskSession>();
    const feedback = createMemoryStore<never>();
    const stores = { sessions, feedback } as unknown as AskStores;
    await sessions.register("ask_test", createSession());
    const reply = vi.fn();
    const handler = createAskInteractiveHandler(stores);

    await handler({
      channel: "discord",
      accountId: "default",
      interactionId: "i2",
      conversationId: "channel:c1",
      senderId: "u2",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: "ask:ask_test:go",
        namespace: "ask",
        payload: "ask_test:go",
        messageId: "m1",
      },
      respond: {
        acknowledge: vi.fn(),
        reply,
        followUp: vi.fn(),
        editMessage: vi.fn(),
        clearComponents: vi.fn(),
      },
      requestConversationBinding: vi.fn(),
      detachConversationBinding: vi.fn(),
      getCurrentConversationBinding: vi.fn(),
    });

    expect((await sessions.lookup("ask_test"))?.status).toBe("open");
    expect(reply).toHaveBeenCalledWith({
      text: "You are not allowed to answer this /ask.",
      ephemeral: true,
    });
  });

  it("keeps grill sessions open and advances to the next question", async () => {
    const sessions = createMemoryStore<AskSession>();
    const feedback = createMemoryStore<never>();
    const stores = { sessions, feedback } as unknown as AskStores;
    await sessions.register(
      "ask_test",
      createSession({
        mode: "grill",
        uiType: "modal",
        options: [],
        grill: {
          initialRequest: "曖昧な依頼を仕様にしたい",
          currentStepIndex: 0,
          answers: [],
        },
      }),
    );
    const editMessage = vi.fn();
    const handler = createAskInteractiveHandler(stores);

    await handler({
      channel: "discord",
      accountId: "default",
      interactionId: "i3",
      conversationId: "channel:c1",
      senderId: "u1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "modal",
        data: "ask:ask_test",
        namespace: "ask",
        payload: "ask_test",
        messageId: "m1",
        fields: [{ id: "f1", name: "answer", values: ["成功条件を固めたい"] }],
      },
      respond: {
        acknowledge: vi.fn(),
        reply: vi.fn(),
        followUp: vi.fn(),
        editMessage,
        clearComponents: vi.fn(),
      },
      requestConversationBinding: vi.fn(),
      detachConversationBinding: vi.fn(),
      getCurrentConversationBinding: vi.fn(),
    });

    const stored = await sessions.lookup("ask_test");
    expect(stored?.status).toBe("open");
    expect(stored?.grill?.currentStepIndex).toBe(1);
    expect(stored?.grill?.answers).toHaveLength(1);
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.objectContaining({
          modal: expect.objectContaining({ triggerLabel: "この質問に答える" }),
        }),
      }),
    );
  });
});
