import { describe, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { resolveModelForSelectedCredential } from "./simple-completion-credential-model.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";

const scoped = vi.hoisted(() => ({ value: true }));
vi.mock("./runtime-plan/credential-scoped-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-plan/credential-scoped-model.js")>()),
  providerUsesCredentialScopedModelMetadata: () => scoped.value,
}));

const unscoped = { provider: "p", id: "m", maxTokens: 1 } as Model;
const authoritative = { provider: "p", id: "m", maxTokens: 2 } as Model;

describe("resolveModelForSelectedCredential", () => {
  it("resolves the model for the selected profile without a store read", async () => {
    scoped.value = true;
    const modelResolver = vi.fn(
      async (..._args: Parameters<SimpleCompletionModelResolver>) =>
        ({ model: authoritative }) as never,
    );
    const model = await resolveModelForSelectedCredential({
      model: unscoped,
      auth: { apiKey: "k", source: "profile:p:two", mode: "oauth", profileId: "p:two" },
      modelResolver,
    });
    expect(model).toBe(authoritative);
    // A prepared mode is authoritative, so discovery does not reselect from the agent store.
    expect(modelResolver.mock.calls[0]?.[4]).toMatchObject({
      authProfileId: "p:two",
      authProfileMode: "oauth",
    });
  });

  it("keeps the model for providers whose limits are not account scoped", async () => {
    scoped.value = false;
    const modelResolver = vi.fn();
    const model = await resolveModelForSelectedCredential({
      model: unscoped,
      auth: { apiKey: "k", source: "env", mode: "api-key" },
      modelResolver,
    });
    expect(model).toBe(unscoped);
    expect(modelResolver).not.toHaveBeenCalled();
  });
});
