// Verifies that auth labels name the credential inference selects for configured providers.
import { describe, expect, it } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { resolveModelAuthLabelAsync } from "./model-auth-label.js";

describe("configured provider auth labels", () => {
  it.each([
    ["api-key", { authProfileOverrideSource: "auto" }, "api-key (models.json)"],
    ["api-key", { authProfileOverrideSource: "user" }, "api-key (ollama-2:ambient)"],
    ["api-key", {}, "api-key (ollama-2:ambient)"],
    ["api-key", { authProfileOverrideCompactionCount: 0 }, "api-key (models.json)"],
    [undefined, undefined, "api-key (ollama-2:ambient)"],
  ] as const)(
    "labels the credential inference selects with auth %s and session override %j",
    async (auth, override, label) => {
      expect(
        await resolveModelAuthLabelAsync({
          provider: "ollama-2",
          cfg: {
            models: {
              providers: {
                "ollama-2": {
                  baseUrl: "http://127.0.0.1:11434",
                  api: "ollama",
                  ...(auth ? { auth } : {}),
                  apiKey: "configured-key",
                  models: [],
                },
              },
            },
          },
          sessionEntry: override
            ? { authProfileOverride: "ollama-2:ambient", ...override }
            : undefined,
          authStore: createAuthProfileStoreFixture({
            "ollama-2:ambient": createApiKeyCredential("ollama-2", "ambient-key"),
          }),
        }),
      ).toBe(label);
    },
  );
});
