import { beforeEach, describe, expect, it, vi } from "vitest";

type GenerateTopicLabelParams = Parameters<
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").generateConversationLabel
>[0];

const h = vi.hoisted(() => {
  const storeState = new Map<string, Record<string, unknown>>();
  return {
    storeState,
    persistent: {
      register: async (key: string, value: Record<string, unknown>) => {
        storeState.set(key, structuredClone(value));
      },
      lookup: async (key: string) => storeState.get(key),
      delete: async (key: string) => {
        storeState.delete(key);
      },
      entries: async () => Array.from(storeState.entries(), ([key, value]) => ({ key, value })),
    },
    editForumTopic: vi.fn(async () => true),
    generateTopicLabel: vi.fn(async (_params: GenerateTopicLabelParams) => "Refined Label"),
    logVerbose: vi.fn(),
  };
});

// mock-isolation: text truncation double keeps string-boundary tests deterministic.
vi.mock("openclaw/plugin-sdk/text-utility-runtime", () => ({
  truncateUtf16Safe: (text: string, max: number) => text.slice(0, max),
}));
// mock-isolation: label generation needs a controlled LLM double; real generator would call live model providers.
vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", () => ({
  generateConversationLabel: h.generateTopicLabel,
}));
// mock-isolation: agent dir resolution must not touch real workspace layout in unit tests.
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveAgentDir: () => "/tmp/agent",
}));
// mock-isolation: keyed store is replaced by an in-memory double; real runtime owns persistent plugin state.
vi.mock("./runtime.js", () => ({
  getTelegramRuntime: () => ({
    state: { openKeyedStore: () => h.persistent },
  }),
}));
// mock-isolation: live topic-name cache writes go to real Telegram state; tests drive the double directly.
// The real account-scope helper stays imported so the scope builder matches production.
vi.mock("./topic-name-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./topic-name-cache.js")>()),
  getTopicName: vi.fn(async () => h.storeState.get("live-name")?.name),
  updateTopicName: vi.fn(async (_chatId: unknown, _threadId: unknown, patch: { name?: string }) => {
    h.storeState.set("live-name", { ...h.storeState.get("live-name"), ...patch });
  }),
}));

import {
  finishInitialTopicLabel,
  maybeRefineTopicLabel,
  prepareTopicLabelTurn,
} from "./topic-label-refinement.js";
import { getTopicName } from "./topic-name-cache.js";

const { storeState, editForumTopic, generateTopicLabel, logVerbose } = h;

const CHAT = -100123;
const THREAD = 42;
const ACCOUNT = "acct-1";
const BOT_ID = 777000;
const base = () => ({
  botId: BOT_ID,
  accountId: ACCOUNT,
  bot: { api: { editForumTopic } },
  assertServiceCurrent: vi.fn(() => undefined),
  cfg: {},
  agentId: "main",
  chatId: CHAT,
  threadId: THREAD,
  userMessage: "later task message",
  afterMessages: 2,
  logVerbose,
});

async function recordInitialLabel(params: {
  botId: number | string | undefined;
  accountId: string;
  chatId: number | string;
  threadId: number;
  label: string;
  lifecycleRevision?: string;
}) {
  const lifecycleRevision = params.lifecycleRevision ?? "r1";
  await prepareTopicLabelTurn({ ...params, lifecycleRevision, currentName: undefined });
  await finishInitialTopicLabel({
    ...base(),
    ...params,
    lifecycleRevision,
    applyInitialLabel: async () => {
      storeState.set("live-name", { name: params.label });
    },
  });
}

beforeEach(() => {
  storeState.clear();
  vi.clearAllMocks();
  generateTopicLabel.mockReset().mockResolvedValue("Refined Label");
  // Production default: a landed auto label is cached (4302875124), so the
  // refinement's manual-rename guard reads back the armed label. Individual
  // tests override this to simulate pending labels, renames, or eviction.
  storeState.set("live-name", { name: "Initial Label" });
});

describe("maybeRefineTopicLabel", () => {
  it("preserves model output rather than imposing default prompt word counts", async () => {
    await recordInitialLabel({ ...base(), label: "Initial Label" });
    generateTopicLabel.mockResolvedValueOnce("YouGile CRM integration planning guide");
    await maybeRefineTopicLabel({ ...base(), afterMessages: 1 });
    expect(editForumTopic).toHaveBeenCalledWith(CHAT, THREAD, {
      name: "YouGile CRM integration planning guide",
    });
    expect(storeState.get("live-name")?.name).toBe("YouGile CRM integration planning guide");
    expect(storeState.get(BOT_ID + ":" + ACCOUNT + ":" + CHAT + ":" + THREAD)?.label).toBe(
      "YouGile CRM integration planning guide",
    );
  });

  it("never truncates a manually chosen long title", async () => {
    await recordInitialLabel({ ...base(), label: "Initial Label" });
    storeState.set("live-name", { name: "My own manually chosen long title" });
    await maybeRefineTopicLabel({ ...base(), afterMessages: 1 });
    expect(editForumTopic).not.toHaveBeenCalled();
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(storeState.get("live-name")?.name).toBe("My own manually chosen long title");
  });

  it.each([undefined, "My manual name"])(
    "does not recover an interrupted initial label over unknown or manual cached name: %s",
    async (name) => {
      storeState.set(`${BOT_ID}:${ACCOUNT}:${CHAT}:${THREAD}`, {
        label: "",
        pendingInitialLabel: "Initial Label",
        count: 0,
        done: false,
      });
      if (name === undefined) {
        storeState.delete("live-name");
      } else {
        storeState.set("live-name", { name });
      }
      await maybeRefineTopicLabel({ ...base(), afterMessages: 1 });
      expect(generateTopicLabel).not.toHaveBeenCalled();
      expect(editForumTopic).not.toHaveBeenCalled();
    },
  );
  it("does nothing without armed state (label not generated by bot)", async () => {
    await maybeRefineTopicLabel(base());
    expect(editForumTopic).not.toHaveBeenCalled();
    expect(generateTopicLabel).not.toHaveBeenCalled();
  });

  it("counts turns and does not refine before threshold", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    await maybeRefineTopicLabel(base());
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(editForumTopic).not.toHaveBeenCalled();
  });

  it("does not count text control commands toward later task messages", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });

    await maybeRefineTopicLabel({ ...base(), userMessage: "/status" });
    await maybeRefineTopicLabel({ ...base(), userMessage: "/help" });
    await maybeRefineTopicLabel({ ...base(), userMessage: "First real task" });
    expect(generateTopicLabel).not.toHaveBeenCalled();

    await maybeRefineTopicLabel({ ...base(), userMessage: "Second real task" });
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
  });

  it("refines exactly once at threshold and renames topic + cache", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    await maybeRefineTopicLabel(base());
    await maybeRefineTopicLabel(base());
    expect(editForumTopic).toHaveBeenCalledTimes(1);
    expect(editForumTopic).toHaveBeenCalledWith(CHAT, THREAD, { name: "Refined Label" });
    // exactly-once: further turns are no-ops
    await maybeRefineTopicLabel(base());
    expect(editForumTopic).toHaveBeenCalledTimes(1);
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
  });

  it("does not share state across accounts (colliding chat/topic ids)", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: "other",
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    await maybeRefineTopicLabel(base());
    await maybeRefineTopicLabel(base());
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(editForumTopic).not.toHaveBeenCalled();
  });

  it("consumes the attempt before the external rename (edit failure does not retry)", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    await maybeRefineTopicLabel(base());
    editForumTopic.mockRejectedValueOnce(new Error("bot api down"));
    await maybeRefineTopicLabel(base());
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
    // attempt was claimed before the edit: no further LLM calls or renames
    await maybeRefineTopicLabel(base());
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
  });

  it("refuses the external rename once the account service is stopped (attempt NOT consumed)", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    await maybeRefineTopicLabel(base());
    const stopping = base();
    stopping.assertServiceCurrent = vi.fn(() => {
      throw new Error("account stopped");
    });
    await maybeRefineTopicLabel(stopping);
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(editForumTopic).not.toHaveBeenCalled();
    // authority check happens BEFORE the durable claim: a stopped account's
    // attempt is NOT spent; a healthy later turn can still refine exactly once
    await maybeRefineTopicLabel(base());
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
    // and still exactly-once afterwards
    await maybeRefineTopicLabel(base());
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
  });

  it("includes bot identity in the refinement key (token rotation cannot rename replacement bot's topic)", async () => {
    await recordInitialLabel({
      botId: 111,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    // Same accountId, different bot after repointing: prior-bot state is invisible.
    await maybeRefineTopicLabel({ ...base(), botId: 222 });
    await maybeRefineTopicLabel({ ...base(), botId: 222 });
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(editForumTopic).not.toHaveBeenCalled();
  });

  it("carries intermediate turns into the refinement source", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    await maybeRefineTopicLabel({ ...base(), userMessage: "first detail" });
    generateTopicLabel.mockClear();
    await maybeRefineTopicLabel({ ...base(), userMessage: "second detail" });
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    const call = generateTopicLabel.mock.calls[0]?.[0];
    expect(call?.userMessage).toContain("Initial Label");
    expect(call?.userMessage).toContain("first detail");
    expect(call?.userMessage).toContain("second detail");
  });

  it.each([1, 2])(
    "resumes a threshold of %i reached before the initial label lands",
    async (afterMessages) => {
      await recordInitialLabel({
        botId: BOT_ID,
        accountId: ACCOUNT,
        chatId: CHAT,
        threadId: THREAD,
        label: "",
      });
      storeState.set("live-name", { name: "Original topic name" });
      for (let turn = 1; turn <= afterMessages; turn++) {
        await maybeRefineTopicLabel({ ...base(), afterMessages, userMessage: `follow-up ${turn}` });
      }
      expect(generateTopicLabel).not.toHaveBeenCalled();
      expect(editForumTopic).not.toHaveBeenCalled();
      // Dispatch caches the generated name before attaching it. No additional
      // task message should be needed to resume an already-reached threshold.
      storeState.set("live-name", { name: "Late Label" });
      await finishInitialTopicLabel({
        ...base(),
        afterMessages,
        label: "Late Label",
        applyInitialLabel: async () => {},
      });
      expect(generateTopicLabel).toHaveBeenCalledTimes(1);
      expect(editForumTopic).toHaveBeenCalledTimes(1);
      const call = generateTopicLabel.mock.calls[0]?.[0];
      expect(call?.userMessage).toContain("Late Label");
      for (let turn = 1; turn <= afterMessages; turn++) {
        expect(call?.userMessage).toContain(`follow-up ${turn}`);
      }
      await maybeRefineTopicLabel({ ...base(), afterMessages, userMessage: "another task" });
      expect(generateTopicLabel).toHaveBeenCalledTimes(1);
      expect(editForumTopic).toHaveBeenCalledTimes(1);
    },
  );

  it("caps retained excerpts independently of the threshold and clears them on claim (4304532547)", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Auto Label",
    });
    storeState.set("live-name", { name: "Auto Label" });
    for (let i = 0; i < 60; i++) {
      await maybeRefineTopicLabel({
        ...base(),
        afterMessages: 100,
        userMessage: `CJK task ${"漢".repeat(450)} ${i}`,
      });
    }
    const key = `${BOT_ID}:${ACCOUNT}:${CHAT}:${THREAD}`;
    const pending = storeState.get(key);
    if (!pending) {
      throw new Error("Expected persisted topic refinement state");
    }
    expect(pending).toMatchObject({ count: 60, done: false });
    expect(pending.excerpts).toHaveLength(8);
    expect((pending.excerpts as string[]).join("").length).toBeLessThanOrEqual(4_000);
    await maybeRefineTopicLabel({ ...base(), afterMessages: 61, userMessage: "last task" });
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(storeState.get(key)).toMatchObject({ done: true, excerpts: [] });
  });

  it("skips refinement without consuming the attempt when the cached name is unavailable (4304532550)", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Auto Label",
    });
    // Cache evicted / never written: the current name is unknown.
    storeState.delete("live-name");
    await maybeRefineTopicLabel({ ...base(), afterMessages: 1, userMessage: "follow-up" });
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(editForumTopic).not.toHaveBeenCalled();
    // The attempt survives; once the name is available again, refinement runs.
    storeState.set("live-name", { name: "Auto Label" });
    await maybeRefineTopicLabel({ ...base(), afterMessages: 1, userMessage: "follow-up two" });
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
  });

  it("marks done without rename when model returns same label or empty", async () => {
    generateTopicLabel.mockResolvedValueOnce("Initial Label");
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    await maybeRefineTopicLabel(base());
    await maybeRefineTopicLabel(base());
    expect(editForumTopic).not.toHaveBeenCalled();
    await maybeRefineTopicLabel(base());
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
  });

  it("skips rename and stops when topic was manually renamed", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    storeState.set("live-name", { name: "My Manual Name" });
    await maybeRefineTopicLabel(base());
    await maybeRefineTopicLabel(base());
    expect(editForumTopic).not.toHaveBeenCalled();
    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("renamed manually"));
    // exactly-once even after manual rename
    await maybeRefineTopicLabel(base());
    expect(generateTopicLabel).not.toHaveBeenCalled();
  });

  it("does not rename when the topic name disappears during inference", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    vi.mocked(getTopicName).mockResolvedValueOnce("Initial Label").mockResolvedValueOnce(undefined);
    await maybeRefineTopicLabel({ ...base(), afterMessages: 1 });
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(editForumTopic).not.toHaveBeenCalled();
    expect(storeState.get(`${BOT_ID}:${ACCOUNT}:${CHAT}:${THREAD}`)).toMatchObject({
      done: true,
      outcome: "failed",
    });
    await maybeRefineTopicLabel({ ...base(), afterMessages: 1 });
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
  });

  it("does not rename through a stopped account after the post-inference cache read", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    await maybeRefineTopicLabel(base());
    let stopped = false;
    // First read (pre-inference guard) returns the armed label so the claim
    // proceeds; the second read (post-inference) coincides with the account
    // stopping. Keep the name unchanged so only the service authority check
    // can prevent the final API effect.
    vi.mocked(getTopicName)
      .mockImplementationOnce(async () => "Initial Label")
      .mockImplementationOnce(async () => {
        stopped = true;
        return "Initial Label";
      });

    await maybeRefineTopicLabel({
      ...base(),
      assertServiceCurrent: () => {
        if (stopped) {
          throw new Error("account stopped");
        }
      },
    });

    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(getTopicName).toHaveBeenCalledTimes(2);
    expect(editForumTopic).not.toHaveBeenCalled();
    await maybeRefineTopicLabel(base());
    expect(editForumTopic).not.toHaveBeenCalled();
  });

  it("marks done on generation failure (no repeated attempts)", async () => {
    generateTopicLabel.mockRejectedValueOnce(new Error("llm down"));
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    await maybeRefineTopicLabel(base());
    await maybeRefineTopicLabel(base());
    expect(editForumTopic).not.toHaveBeenCalled();
    expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("refinement failed"));
    await maybeRefineTopicLabel(base());
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
  });

  it.each(["before", "during"] as const)(
    "honors WebUI naming authority %s refinement inference",
    async (timing) => {
      await recordInitialLabel({ ...base(), label: "Initial Label" });
      let manual = timing === "before";
      const assertLifecycleCurrent = vi.fn(async () => {
        if (manual) {
          throw new Error("manual WebUI label selected");
        }
      });
      generateTopicLabel.mockImplementationOnce(async () => {
        manual = true;
        return "Changed task";
      });
      await maybeRefineTopicLabel({ ...base(), afterMessages: 1, assertLifecycleCurrent });
      expect(editForumTopic).not.toHaveBeenCalled();
      expect(generateTopicLabel).toHaveBeenCalledTimes(timing === "before" ? 0 : 1);
    },
  );

  it("serializes concurrent turns so the single attempt is claimed exactly once (4304709772)", async () => {
    await recordInitialLabel({
      botId: BOT_ID,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: THREAD,
      label: "Initial Label",
    });
    await Promise.all([
      maybeRefineTopicLabel({ ...base(), afterMessages: 1, userMessage: "First task" }),
      maybeRefineTopicLabel({ ...base(), afterMessages: 1, userMessage: "Second task" }),
    ]);
    expect(generateTopicLabel).toHaveBeenCalledTimes(1);
    expect(editForumTopic).toHaveBeenCalledTimes(1);
    expect(storeState.get(`${BOT_ID}:${ACCOUNT}:${CHAT}:${THREAD}`)).toMatchObject({
      done: true,
      count: 1,
    });
  });
});

describe("topic naming lifecycle", () => {
  const target = { botId: BOT_ID, accountId: ACCOUNT, chatId: CHAT, threadId: THREAD };
  beforeEach(() => storeState.clear());
  it("admits the first substantive turn once and joins later turns to refinement", async () => {
    expect(
      await prepareTopicLabelTurn({ ...target, lifecycleRevision: "r1", currentName: undefined }),
    ).toBe("initial");
    expect(
      await prepareTopicLabelTurn({ ...target, lifecycleRevision: "r1", currentName: undefined }),
    ).toBe("refine");
  });
  it("does not adopt a pre-existing manual title", async () => {
    expect(
      await prepareTopicLabelTurn({
        ...target,
        lifecycleRevision: "r1",
        currentName: "My manual title",
      }),
    ).toBe("skip");
    expect(storeState.size).toBe(0);
  });
  it("reassesses an owned title after lifecycle change, but preserves a manual rename", async () => {
    await recordInitialLabel({ ...target, label: "YouGile CRM", lifecycleRevision: "r1" });
    expect(
      await prepareTopicLabelTurn({ ...target, lifecycleRevision: "r2", currentName: "Manual" }),
    ).toBe("skip");
    expect(
      await prepareTopicLabelTurn({
        ...target,
        lifecycleRevision: "r2",
        currentName: "YouGile CRM",
      }),
    ).toBe("initial");
  });
  it("retains generated-name ownership when reset inference fails and another reset follows", async () => {
    const key = `${BOT_ID}:${ACCOUNT}:${CHAT}:${THREAD}`;
    storeState.set(key, { label: "YouGile CRM", count: 0, done: true, lifecycleRevision: "r1" });
    expect(
      await prepareTopicLabelTurn({
        ...target,
        lifecycleRevision: "r2",
        currentName: "YouGile CRM",
      }),
    ).toBe("initial");
    // No finishInitialTopicLabel call: inference failed or returned empty.
    expect(storeState.get(key)?.label).toBe("YouGile CRM");
    expect(
      await prepareTopicLabelTurn({
        ...target,
        lifecycleRevision: "r3",
        currentName: "YouGile CRM",
      }),
    ).toBe("initial");
  });
});
