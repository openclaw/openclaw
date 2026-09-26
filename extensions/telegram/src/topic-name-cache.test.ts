import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramTopicNameCacheForTest,
} from "./runtime.test-support.js";
import { getTopicName, updateTopicName } from "./topic-name-cache.js";

describe("topic-name-cache", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "telegram-topic-names-",
      layout: "state-only",
      applyEnv: true,
    });
    setTelegramPluginStateRuntimeForTests();
    resetTelegramTopicNameCacheForTest();
  });

  afterEach(async () => {
    resetTelegramTopicNameCacheForTest();
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
    await state.cleanup();
  });

  it("preserves a renamed topic through status-only events without inventing unnamed topics", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments" });
    await updateTopicName(-100123, 42, { name: "CI/CD" });
    await updateTopicName(-100123, 42, { closed: true });
    await updateTopicName(-100123, 43, { closed: true });
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicName(-100123, 42)).resolves.toBe("CI/CD");
    await expect(getTopicName(-100123, 43)).resolves.toBeUndefined();
  });

  it("retains active topics and evicts the inactive oldest topic across database reopen", async () => {
    await updateTopicName(-100000, 1, { name: "Active" });
    for (let id = 2; id <= 2048; id++) {
      await updateTopicName(-100000, id, { name: `Topic ${id}` });
    }
    await getTopicName(-100000, 1);
    await updateTopicName(-100000, 9999, { name: "Newcomer" });
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicName(-100000, 2)).resolves.toBeUndefined();
    await expect(getTopicName(-100000, 1)).resolves.toBe("Active");
    await expect(getTopicName(-100000, 9999)).resolves.toBe("Newcomer");
  });

  it("isolates identical topic coordinates in separate persisted scopes", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments" }, "first");
    await updateTopicName(-100123, 42, { name: "Incidents" }, "second");
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    await expect(getTopicName(-100123, 42, "first")).resolves.toBe("Deployments");
    await expect(getTopicName(-100123, 42, "second")).resolves.toBe("Incidents");
  });
});
