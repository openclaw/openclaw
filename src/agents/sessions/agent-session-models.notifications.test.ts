import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import { hasModelFallbackStop } from "../failover-error.js";
import {
  createModelSelectionSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
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

async function createNotificationSession(
  options: {
    reasoning?: boolean;
    thinking?: (event: ThinkingLevelSelectEvent) => Promise<void>;
    model?: () => Promise<void>;
  } = {},
) {
  return createModelSelectionSession({
    model: options.reasoning === false ? plainModel : reasoningModel,
    models: [reasoningModel, plainModel],
    thinkingLevel: "high",
    onThinkingSelect: async (event) => options.thinking?.(event),
    onModelSelect: async () => options.model?.(),
  });
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

async function expectPending(work: Promise<unknown>) {
  const pending = Symbol("pending");
  expect(await Promise.race([work, setImmediate().then(() => pending)])).toBe(pending);
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
    const nestedFailureReady = createDeferredCore<SessionMetadataCommittedError>();
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

    const outcome = fixture.session.setThinkingLevel("low").catch((error: unknown) => error);
    const nestedFailure = await nestedFailureReady.promise;
    expect(await outcome).toBe(nestedFailure);
    expect(fixture.sessionManager.getEntries().slice(before)).toMatchObject([
      { type: "thinking_level_change", thinkingLevel: "low" },
      { type: "thinking_level_change", thinkingLevel: "medium" },
    ]);
    expect(fixture.session.thinkingLevel).toBe("medium");
    expect(fixture.settingsManager.getDefaultThinkingLevel()).toBe("medium");
  });

  it("joins both started hooks and retains both notification failures", async () => {
    const modelHook = createEnteredGate();
    const failures: Error[] = [];
    const failHook = (kind: string) => {
      const failure = notificationFailure(fixture, new Error(`${kind} hook failed`));
      failures.push(failure);
      throw failure;
    };
    const fixture = await createNotificationSession({
      reasoning: false,
      thinking: async () => failHook("thinking"),
      model: async () => {
        await modelHook.wait();
        failHook("model");
      },
    });
    const outcome = fixture.session.setModel(reasoningModel).catch((error: unknown) => error);
    try {
      await modelHook.entered;
      await expectPending(outcome);
    } finally {
      modelHook.release();
    }
    const failure = await outcome;
    expect(failure).toBeInstanceOf(SessionMetadataCommittedError);
    expect(failure).toMatchObject({ cause: { errors: failures } });
    expect(failures).toHaveLength(2);
    expect(hasModelFallbackStop(failure)).toBe(true);
  });

  it("serializes detached model transitions without losing the saved thinking level", async () => {
    const { session, sessionManager, settingsManager } = await createNotificationSession();
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

  it("refuses queued detached model changes after the extension runtime is invalidated", async () => {
    const { session, sessionManager, settingsManager, extensionRuntime } =
      await createNotificationSession();
    expect(sessionManager.getSessionTarget()).toBeUndefined();
    const selection = () => [
      session.thinkingLevel,
      settingsManager.getGlobalSettings().defaultModel,
      settingsManager.getDefaultThinkingLevel(),
    ];
    const before = selection();
    const model = session.model;
    const entries = structuredClone(sessionManager.getEntries());
    const gate = createEnteredGate();
    const held = withSessionManagerWrite(sessionManager, gate.wait);
    await gate.entered;
    const change = extensionRuntime.setModel(plainModel).catch((error: unknown) => error);
    try {
      await expectPending(change);
      expect(sessionManager.getEntries()).toEqual(entries);
      extensionRuntime.invalidate("detached extension invalidated while queued");
    } finally {
      gate.release();
      await held;
      await change;
    }
    const failure = await change;
    expect.soft(sessionManager.getEntries()).toEqual(entries);
    expect.soft(session.model).toBe(model);
    expect.soft(selection()).toEqual(before);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: "detached extension invalidated while queued",
    });
    expect(hasModelFallbackStop(failure)).toBe(false);
  });
});
