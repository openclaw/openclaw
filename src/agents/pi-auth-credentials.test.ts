import { describe, expect, it } from "vitest";
import { convertAuthProfileCredentialToPi } from "./pi-auth-credentials.js";

async function withEnvVar(name: string, value: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

describe("convertAuthProfileCredentialToPi", () => {
  it("resolves api_key credentials from env keyRef", async () => {
    await withEnvVar("OPENROUTER_API_KEY", "sk-or-v1-test-key", async () => {
      expect(
        convertAuthProfileCredentialToPi({
          type: "api_key",
          provider: "openrouter",
          keyRef: { source: "env", provider: "default", id: "OPENROUTER_API_KEY" },
        }),
      ).toEqual({
        type: "api_key",
        key: "sk-or-v1-test-key",
      });
    });
  });

  it("resolves token credentials from env tokenRef", async () => {
    await withEnvVar("ANTHROPIC_TOKEN", "sk-ant-test-token", async () => {
      expect(
        convertAuthProfileCredentialToPi({
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
        }),
      ).toEqual({
        type: "api_key",
        key: "sk-ant-test-token",
      });
    });
  });

  it("prefers inline credentials over env refs when both are present", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-from-env";
    try {
      expect(
        convertAuthProfileCredentialToPi({
          type: "api_key",
          provider: "openrouter",
          key: "sk-or-v1-inline",
          keyRef: { source: "env", provider: "default", id: "OPENROUTER_API_KEY" },
        }),
      ).toEqual({
        type: "api_key",
        key: "sk-or-v1-inline",
      });
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});
