import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
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

const reasoningModel = {
  ...testModel,
  id: "notification-reasoning",
  reasoning: true,
};
const plainModel = { ...reasoningModel, id: "notification-plain", reasoning: false };

registerAgentSessionLoopTestLifecycle();

async function createSession(
  reasoning = true,
  thinking?: (event: ThinkingLevelSelectEvent) => Promise<void>,
  model?: () => Promise<void>,
) {
  const resourceLoader = createResourceLoader(
    new Map([
      [
        "thinking_level_select",
        [async (event: unknown) => thinking?.(event as ThinkingLevelSelectEvent)],
      ],
      ["model_select", [async () => model?.()]],
    ]),
  );
  const fixture = await createTestSession({
    model: reasoning ? reasoningModel : plainModel,
    thinkingLevel: "high",
    resourceLoader,
  });
  fixture.modelRegistry.registerProvider(testModel.provider, {
    api: testModel.api,
    baseUrl: testModel.baseUrl,
    models: [reasoningModel, plainModel],
  });
  const { session, sessionManager: manager, settingsManager: settings } = fixture;
  const start = manager.getEntries().length;
  return {
    session,
    manager,
    settings,
    runtime: resourceLoader.getExtensions().runtime,
    changes: () => manager.getEntries().slice(start),
    thinking: () => [session.thinkingLevel, settings.getDefaultThinkingLevel()],
  };
}

function notificationFailure({ manager }: Awaited<ReturnType<typeof createSession>>, cause: Error) {
  const entry = manager.getEntries().at(-1);
  if (!entry || (entry.type !== "model_change" && entry.type !== "thinking_level_change")) {
    throw new Error("Expected committed metadata before notifying observers");
  }
  return new SessionMetadataCommittedError(entry, undefined, cause, manager.getSessionTarget());
}

function observeOutcome(operation: Promise<unknown>) {
  const observed = { settled: false, result: operation.catch((error: unknown) => error) };
  void observed.result.then(() => {
    observed.settled = true;
  });
  return observed;
}

it.each(["thinking", "model", "nested"] as const)(
  "retains committed metadata and awaits %s notification failures",
  async (kind) => {
    const nested = kind === "nested";
    const nestedFailureReady = createDeferredCore<SessionMetadataCommittedError>();
    const fixture = await createSession(
      kind !== "model",
      nested
        ? async (event) => {
            if (event.level === "low") {
              await fixture.session.setThinkingLevel("medium");
            }
          }
        : undefined,
    );
    const cause = new Error(nested ? "nested notification failed" : "notification listener failed");
    fixture.session.subscribe((event) => {
      if (event.type === "thinking_level_changed" && (!nested || event.level === "medium")) {
        const failure = nested ? notificationFailure(fixture, cause) : cause;
        if (failure instanceof SessionMetadataCommittedError) {
          nestedFailureReady.resolve(failure);
        }
        throw failure;
      }
    });

    const outcome = (
      kind === "model"
        ? fixture.session.setModel(reasoningModel)
        : fixture.session.setThinkingLevel("low")
    ).catch((error: unknown) => error);
    const nestedFailure = nested ? await nestedFailureReady.promise : undefined;
    const failure = await outcome;
    const entries = fixture.changes();
    expect(entries).toHaveLength(kind === "thinking" ? 1 : 2);
    const level = nested ? "medium" : kind === "thinking" ? "low" : "high";
    expect(fixture.thinking()).toEqual([level, level]);
    expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
    expect(failure).toMatchObject({ committedEntry: entries.at(-1), cause });
    expect(hasModelFallbackStop(failure)).toBe(true);
    if (nested) {
      expect(failure).toBe(nestedFailure);
      expect(entries).toMatchObject([
        { type: "thinking_level_change", thinkingLevel: "low" },
        { type: "thinking_level_change", thinkingLevel: "medium" },
      ]);
    }
  },
);

it("joins both started hooks and retains both notification failures", async () => {
  const modelHookStarted = createDeferredCore();
  const releaseModelHook = createDeferredCore();
  const failures: Error[] = [];
  const failHook = (message: string) => {
    const failure = notificationFailure(fixture, new Error(message));
    failures.push(failure);
    throw failure;
  };
  const fixture = await createSession(
    false,
    async () => failHook("thinking hook failed"),
    async () => {
      modelHookStarted.resolve();
      await releaseModelHook.promise;
      failHook("model hook failed");
    },
  );
  const outcome = observeOutcome(fixture.session.setModel(reasoningModel));
  try {
    await modelHookStarted.promise;
    await setImmediate();
    expect(outcome.settled).toBe(false);
  } finally {
    releaseModelHook.resolve();
  }
  const failure = await outcome.result;
  expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
  expect(failure).toMatchObject({ cause: { errors: failures } });
  expect(failures).toHaveLength(2);
  expect(hasModelFallbackStop(failure)).toBe(true);
});

it("serializes detached model transitions without losing the saved thinking level", async () => {
  const { session, changes, thinking } = await createSession();
  expect(session.thinkingLevel).toBe("high");

  await Promise.all([session.setModel(plainModel), session.setModel(reasoningModel)]);

  expect(session.model?.id).toBe(reasoningModel.id);
  expect(thinking()).toEqual(["high", "high"]);
  expect(changes()).toMatchObject([
    { type: "model_change", modelId: plainModel.id },
    { type: "thinking_level_change", thinkingLevel: "off" },
    { type: "model_change", modelId: reasoningModel.id },
    { type: "thinking_level_change", thinkingLevel: "high" },
  ]);
});

it("refuses queued detached model changes after the extension runtime is invalidated", async () => {
  const { session, manager, settings, runtime, thinking } = await createSession();
  expect(manager.getSessionTarget()).toBeUndefined();
  const before = {
    entries: structuredClone(manager.getEntries()),
    model: session.model,
    thinking: thinking(),
    defaultModel: settings.getDefaultModel(),
  };
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = withSessionManagerWrite(manager, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const change = observeOutcome(runtime.setModel(plainModel));
  try {
    await setImmediate();
    expect(change.settled).toBe(false);
    expect(manager.getEntries()).toEqual(before.entries);
    runtime.invalidate("detached extension invalidated while queued");
  } finally {
    release.resolve();
    await held;
    await change.result;
  }
  const failure = await change.result;
  expect.soft(manager.getEntries()).toEqual(before.entries);
  expect.soft(session.model).toBe(before.model);
  expect.soft(thinking()).toEqual(before.thinking);
  expect.soft(settings.getDefaultModel()).toBe(before.defaultModel);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    message: "detached extension invalidated while queued",
  });
  expect(hasModelFallbackStop(failure)).toBe(false);
});
