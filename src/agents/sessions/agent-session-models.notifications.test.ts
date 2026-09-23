import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { hasModelFallbackStop } from "../failover-error.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { ThinkingLevelSelectEvent } from "./extensions/types.js";
import { SessionMetadataCommittedError } from "./session-manager-metadata-error.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import { SettingsManager } from "./settings-manager.js";

const reasoningModel = {
  ...testModel,
  id: "notification-reasoning",
  reasoning: true,
  contextWindow: 32_768,
  maxTokens: 8_192,
};
const plainModel = { ...reasoningModel, id: "notification-plain", reasoning: false };

registerAgentSessionLoopTestLifecycle();

async function createNotificationSession(
  options: {
    reasoning?: boolean;
    thinking?: (event: ThinkingLevelSelectEvent) => Promise<void>;
    model?: () => Promise<void>;
  } = {},
) {
  const resourceLoader = createResourceLoader(
    new Map([
      [
        "thinking_level_select",
        [async (event: unknown) => options.thinking?.(event as ThinkingLevelSelectEvent)],
      ],
      ["model_select", [async () => options.model?.()]],
    ]),
  );
  const fixture = await createTestSession({
    model: options.reasoning === false ? plainModel : reasoningModel,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultThinkingLevel: "high",
    }),
    resourceLoader,
  });
  fixture.modelRegistry.registerProvider(testModel.provider, {
    api: testModel.api,
    baseUrl: testModel.baseUrl,
    models: [reasoningModel, plainModel],
  });
  return { ...fixture, extensionRuntime: resourceLoader.getExtensions().runtime };
}

function notificationFailure(
  fixture: Awaited<ReturnType<typeof createNotificationSession>>,
  cause: Error,
) {
  const entry = fixture.sessionManager.getEntries().at(-1);
  if (!entry || (entry.type !== "model_change" && entry.type !== "thinking_level_change")) {
    throw new Error("Expected committed metadata before notifying observers");
  }
  return new SessionMetadataCommittedError(
    entry,
    undefined,
    cause,
    fixture.sessionManager.getSessionTarget(),
  );
}

describe("metadata notifications after publication", () => {
  it.each(["thinking", "model"] as const)(
    "retains the committed receipt when a synchronous %s-change listener throws",
    async (kind) => {
      const fixture = await createNotificationSession({ reasoning: kind === "thinking" });
      const before = fixture.sessionManager.getEntries().length;
      const cause = new Error("notification listener failed");
      fixture.session.subscribe((event) => {
        if (event.type === "thinking_level_changed") {
          throw cause;
        }
      });

      const failure: unknown = await (
        kind === "thinking"
          ? fixture.session.setThinkingLevel("low")
          : fixture.session.setModel(reasoningModel)
      ).catch((error: unknown) => error);

      const entries = fixture.sessionManager.getEntries().slice(before);
      expect(entries).toHaveLength(kind === "thinking" ? 1 : 2);
      expect(fixture.session.thinkingLevel).toBe(kind === "thinking" ? "low" : "high");
      expect(fixture.settingsManager.getDefaultThinkingLevel()).toBe(fixture.session.thinkingLevel);
      expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
      expect(failure).toMatchObject({ committedEntry: entries.at(-1), cause });
      expect(hasModelFallbackStop(failure)).toBe(true);
    },
  );

  it("awaits reentrant thinking hooks and preserves their nested committed failure", async () => {
    const nestedFailureReady =
      createDeferredCore<InstanceType<typeof SessionMetadataCommittedError>>();
    const fixture = await createNotificationSession({
      thinking: async (event) => {
        if (event.level === "low") {
          await fixture.session.setThinkingLevel("medium");
        }
      },
    });
    const before = fixture.sessionManager.getEntries().length;
    fixture.session.subscribe((event) => {
      if (event.type === "thinking_level_changed" && event.level === "medium") {
        const failure = notificationFailure(fixture, new Error("nested notification failed"));
        nestedFailureReady.resolve(failure);
        throw failure;
      }
    });

    const outcome = fixture.session.setThinkingLevel("low").then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const nestedFailure = await nestedFailureReady.promise;
    expect(await outcome).toEqual({ status: "rejected", error: nestedFailure });
    expect(fixture.sessionManager.getEntries().slice(before)).toMatchObject([
      { type: "thinking_level_change", thinkingLevel: "low" },
      { type: "thinking_level_change", thinkingLevel: "medium" },
    ]);
    expect(fixture.session.thinkingLevel).toBe("medium");
    expect(fixture.settingsManager.getDefaultThinkingLevel()).toBe("medium");
  });

  it("joins both started hooks and retains both notification failures", async () => {
    const modelHookStarted = createDeferredCore();
    const releaseModelHook = createDeferredCore();
    const failures: Error[] = [];
    const fixture = await createNotificationSession({
      reasoning: false,
      thinking: async () => {
        const failure = notificationFailure(fixture, new Error("thinking hook failed"));
        failures.push(failure);
        throw failure;
      },
      model: async () => {
        modelHookStarted.resolve();
        await releaseModelHook.promise;
        const failure = notificationFailure(fixture, new Error("model hook failed"));
        failures.push(failure);
        throw failure;
      },
    });
    let settled = false;
    const outcome = fixture.session.setModel(reasoningModel).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await modelHookStarted.promise;
      await setImmediate();
      expect(settled).toBe(false);
    } finally {
      releaseModelHook.resolve();
    }
    const failure = await outcome;
    expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
    expect(failure).toMatchObject({ cause: { errors: failures } });
    expect(failures).toHaveLength(2);
    expect(hasModelFallbackStop(failure)).toBe(true);
  });

  it("serializes detached model transitions without losing the saved thinking level", async () => {
    const { session, sessionManager, settingsManager } = await createNotificationSession();
    expect(session.thinkingLevel).toBe("high");
    const before = sessionManager.getEntries().length;

    await Promise.all([session.setModel(plainModel), session.setModel(reasoningModel)]);

    expect(session.model?.id).toBe(reasoningModel.id);
    expect(session.thinkingLevel).toBe("high");
    expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
    expect(sessionManager.getEntries().slice(before)).toMatchObject([
      { type: "model_change", modelId: plainModel.id },
      { type: "thinking_level_change", thinkingLevel: "off" },
      { type: "model_change", modelId: reasoningModel.id },
      { type: "thinking_level_change", thinkingLevel: "high" },
    ]);
  });

  it.each(["model", "thinking"] as const)(
    "refuses queued detached %s changes after the extension runtime is invalidated",
    async (kind) => {
      const { session, sessionManager, settingsManager, extensionRuntime } =
        await createNotificationSession();
      expect(sessionManager.getSessionTarget()).toBeUndefined();
      const before = {
        entries: structuredClone(sessionManager.getEntries()),
        model: session.model,
        thinking: session.thinkingLevel,
        defaultModel: settingsManager.getDefaultModel(),
        defaultThinking: settingsManager.getDefaultThinkingLevel(),
      };
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const held = withSessionManagerWrite(sessionManager, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let settled = false;
      const change = (
        kind === "model"
          ? extensionRuntime.setModel(plainModel)
          : extensionRuntime.setThinkingLevel("low")
      ).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      void change.then(() => {
        settled = true;
      });
      try {
        await setImmediate();
        expect(settled).toBe(false);
        expect(sessionManager.getEntries()).toEqual(before.entries);
        extensionRuntime.invalidate("detached extension invalidated while queued");
      } finally {
        release.resolve();
        await held;
        await change;
      }
      const outcome = await change;
      expect.soft(sessionManager.getEntries()).toEqual(before.entries);
      expect.soft(session.model).toBe(before.model);
      expect.soft(session.thinkingLevel).toBe(before.thinking);
      expect.soft(settingsManager.getDefaultModel()).toBe(before.defaultModel);
      expect.soft(settingsManager.getDefaultThinkingLevel()).toBe(before.defaultThinking);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toMatchObject({
          message: "detached extension invalidated while queued",
        });
        expect(hasModelFallbackStop(outcome.error)).toBe(false);
      }
    },
  );
});
