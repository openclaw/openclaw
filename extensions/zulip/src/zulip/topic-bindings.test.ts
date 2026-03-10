import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as sessionBindingTesting,
  getSessionBindingService,
} from "../../../../src/infra/outbound/session-binding-service.js";
import {
  __testing,
  createZulipTopicBindingManager,
  resolveZulipTopicConversationId,
  resolveZulipTopicSessionBinding,
  setZulipTopicBindingIdleTimeoutBySessionKey,
  setZulipTopicBindingMaxAgeBySessionKey,
} from "./topic-bindings.js";

describe("zulip topic bindings", () => {
  beforeEach(() => {
    __testing.resetZulipTopicBindingsForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __testing.resetZulipTopicBindingsForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it("registers a zulip binding adapter and resolves stable topic bindings", async () => {
    createZulipTopicBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 30_000,
    });

    const first = await resolveZulipTopicSessionBinding({
      accountId: "work",
      stream: "ops",
      topic: "deploy",
      routeSessionKey: "agent:cody:zulip:default",
      agentId: "cody",
    });
    const second = await resolveZulipTopicSessionBinding({
      accountId: "work",
      stream: "ops",
      topic: "deploy",
      routeSessionKey: "agent:archie:zulip:default",
      agentId: "archie",
    });

    expect(first.isNewBinding).toBe(true);
    expect(first.sessionKey).toMatch(/^agent:cody:zulip:default:topic:deploy:b:\d+$/);
    expect(second.isNewBinding).toBe(false);
    expect(second.sessionKey).toBe(first.sessionKey);

    const resolved = getSessionBindingService().resolveByConversation({
      channel: "zulip",
      accountId: "work",
      conversationId: resolveZulipTopicConversationId({ stream: "ops", topic: "deploy" }),
    });
    expect(resolved?.targetSessionKey).toBe(first.sessionKey);
  });

  it("updates lifecycle windows by session key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T10:00:00.000Z"));
    const manager = createZulipTopicBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    const first = await resolveZulipTopicSessionBinding({
      accountId: "work",
      stream: "ops",
      topic: "deploy",
      routeSessionKey: "agent:cody:zulip:default",
      agentId: "cody",
    });
    const original = manager.listBySessionKey(first.sessionKey)[0];
    expect(original).toBeDefined();

    const idleUpdated = setZulipTopicBindingIdleTimeoutBySessionKey({
      accountId: "work",
      targetSessionKey: first.sessionKey,
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    });
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));
    const maxAgeUpdated = setZulipTopicBindingMaxAgeBySessionKey({
      accountId: "work",
      targetSessionKey: first.sessionKey,
      maxAgeMs: 6 * 60 * 60 * 1000,
    });

    expect(idleUpdated).toHaveLength(1);
    expect(idleUpdated[0]?.idleTimeoutMs).toBe(2 * 60 * 60 * 1000);
    expect(maxAgeUpdated).toHaveLength(1);
    expect(maxAgeUpdated[0]?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
    expect(maxAgeUpdated[0]?.boundAt).toBe(original?.boundAt);
    expect(maxAgeUpdated[0]?.lastActivityAt).toBe(Date.parse("2026-03-10T12:00:00.000Z"));
    expect(manager.listBySessionKey(first.sessionKey)[0]?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
  });

  it("unbinds expired topic bindings and creates a fresh session on the next message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T10:00:00.000Z"));
    const manager = createZulipTopicBindingManager({
      accountId: "work",
      persist: false,
      idleTimeoutMs: 1_000,
      maxAgeMs: 0,
    });

    const first = await resolveZulipTopicSessionBinding({
      accountId: "work",
      stream: "ops",
      topic: "deploy",
      routeSessionKey: "agent:cody:zulip:default",
      agentId: "cody",
    });

    vi.advanceTimersByTime(61_000);
    expect(manager.getByTopic("ops", "deploy")).toBeUndefined();

    const rebound = await resolveZulipTopicSessionBinding({
      accountId: "work",
      stream: "ops",
      topic: "deploy",
      routeSessionKey: "agent:cody:zulip:default",
      agentId: "cody",
    });

    expect(rebound.isNewBinding).toBe(true);
    expect(rebound.sessionKey).not.toBe(first.sessionKey);
    expect(rebound.sessionKey).toMatch(/^agent:cody:zulip:default:topic:deploy:b:\d+$/);
  });
});
