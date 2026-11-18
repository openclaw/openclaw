import { expect, it, vi } from "vitest";
import { SessionCompanionAskError } from "../../../gateway/session-companion-errors.js";
import { assertSessionCompanionImageInput } from "../../../gateway/session-companion-policy.js";
import type { Model } from "../../../llm/types.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";

function fixture(supportsImages = false, assertModelInput?: (model: Pick<Model, "input">) => void) {
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
  return { input, snapshot, model };
}

it.each([false, true])(
  "admits the actual prepared model before dispatch (image support: %s)",
  async (supportsImages) => {
    const afterAdmission = new Error(
      "Admission complete; stop before workspace and backend effects",
    );
    const guard = vi.fn((model: Pick<Model, "input">) => {
      assertSessionCompanionImageInput(model);
      throw afterAdmission;
    });
    const { input, snapshot, model } = fixture(supportsImages, guard);

    if (supportsImages) {
      await expect(prepareAndDispatchEmbeddedRunAttempt(input)).rejects.toBe(afterAdmission);
    } else {
      await expect(prepareAndDispatchEmbeddedRunAttempt(input)).rejects.toBeInstanceOf(
        SessionCompanionAskError,
      );
    }
    // Dispatch adds provider-runtime symbols without replacing the prepared input facts.
    expect(guard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(model));
    expect(guard.mock.calls[0]?.[0].input).toBe(model.input);
    expect(snapshot).toHaveBeenCalledOnce();
  },
);
