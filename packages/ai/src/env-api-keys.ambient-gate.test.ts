// Covers the host-owned ambient-credential gate on the inference lookup path.
import { afterEach, describe, expect, it } from "vitest";
import { getEnvApiKey, findEnvKeys } from "./env-api-keys.js";
import { configureAiTransportHost } from "./host.js";

const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;

afterEach(() => {
  configureAiTransportHost({ allowAmbientProviderKey: () => true });
  if (ORIGINAL_OPENAI_API_KEY === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  }
});

describe("getEnvApiKey ambient gate", () => {
  it("returns the credential when the host allows ambient keys", () => {
    process.env.OPENAI_API_KEY = "sk-ambient-value";
    configureAiTransportHost({ allowAmbientProviderKey: () => true });
    expect(getEnvApiKey("openai")).toBe("sk-ambient-value");
  });

  it("withholds the credential when the host refuses ambient keys", () => {
    process.env.OPENAI_API_KEY = "sk-ambient-value";
    configureAiTransportHost({ allowAmbientProviderKey: () => false });
    expect(getEnvApiKey("openai")).toBeUndefined();
  });

  it("keeps the variable visible to reporting even when refused", () => {
    process.env.OPENAI_API_KEY = "sk-ambient-value";
    configureAiTransportHost({ allowAmbientProviderKey: () => false });
    // findEnvKeys reports presence; only value resolution is gated.
    expect(findEnvKeys("openai")).toEqual(["OPENAI_API_KEY"]);
  });

  // Platform credential providers are ambient in the same sense: the process
  // environment selects them and no configuration names them.
  it("refuses AWS platform credentials for bedrock when the host refuses ambient keys", () => {
    const originalProfile = process.env.AWS_PROFILE;
    process.env.AWS_PROFILE = "default";
    try {
      configureAiTransportHost({ allowAmbientProviderKey: () => true });
      expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");

      configureAiTransportHost({ allowAmbientProviderKey: () => false });
      expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
    } finally {
      if (originalProfile === undefined) {
        delete process.env.AWS_PROFILE;
      } else {
        process.env.AWS_PROFILE = originalProfile;
      }
    }
  });
});
