import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { SessionCompanionAskError } from "../../../gateway/session-companion-errors.js";
import { assertSessionCompanionImageInput } from "../../../gateway/session-companion-policy.js";
import type { Model } from "../../../llm/types.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";

afterEach(() => vi.restoreAllMocks());

function fixture(model: Model, assertModelInput?: (model: Pick<Model, "input">) => void) {
  const snapshot = vi.fn(() => ({
    effectiveModel: model,
    providerRuntimeHandle: { provider: model.provider },
  }));
  const input = {
    runInput: {
      runParams: { assertModelInput },
      progressController: {},
      laneController: {},
      workspaceDir: "/synthetic-side-chat-input",
    },
    preparedRuntime: { snapshot },
  } as unknown as Parameters<typeof prepareAndDispatchEmbeddedRunAttempt>[0];
  return { input, snapshot };
}

it.each([false, true])(
  "admits the actual prepared model before dispatch (image support: %s)",
  async (supportsImages) => {
    const model = makeProviderModelFixture({
      id: "prepared-model",
      name: "Prepared model",
      provider: "synthetic",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:1",
      input: supportsImages ? ["text", "image"] : ["text"],
      contextWindow: 8192,
      maxTokens: 1024,
    });
    const guard = vi.fn(assertSessionCompanionImageInput);
    const { input, snapshot } = fixture(model, guard);
    const afterAdmission = new Error(
      "Admission complete; stop before workspace and backend effects",
    );
    const mkdir = vi.spyOn(fs, "mkdir").mockRejectedValue(afterAdmission);

    if (supportsImages) {
      await expect(prepareAndDispatchEmbeddedRunAttempt(input)).rejects.toBe(afterAdmission);
      expect(mkdir).toHaveBeenCalledOnce();
      expect(guard.mock.invocationCallOrder[0]).toBeLessThan(mkdir.mock.invocationCallOrder[0]!);
    } else {
      await expect(prepareAndDispatchEmbeddedRunAttempt(input)).rejects.toBeInstanceOf(
        SessionCompanionAskError,
      );
      expect(mkdir).not.toHaveBeenCalled();
    }
    // Dispatch adds provider-runtime symbols without replacing the prepared input facts.
    expect(guard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(model));
    expect(guard.mock.calls[0]?.[0].input).toBe(model.input);
    expect(snapshot).toHaveBeenCalledOnce();
  },
);

it("leaves callers without an input admission guard unchanged", async () => {
  const model = makeProviderModelFixture({
    id: "text-model",
    name: "Text model",
    provider: "synthetic",
    api: "openai-responses",
    baseUrl: "http://127.0.0.1:1",
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 1024,
  });
  const { input } = fixture(model);
  const afterAdmission = new Error("Stop before workspace effects");
  const mkdir = vi.spyOn(fs, "mkdir").mockRejectedValue(afterAdmission);
  await expect(prepareAndDispatchEmbeddedRunAttempt(input)).rejects.toBe(afterAdmission);
  expect(mkdir).toHaveBeenCalledOnce();
});
