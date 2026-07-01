// Amazon Bedrock tests cover embedding provider plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing, hasAwsCredentials } from "./embedding-provider.js";

describe("hasAwsCredentials", () => {
  afterEach(() => {
    testing.resetAwsCredentialProbeCacheForTesting();
  });
  it("accepts static AWS key credentials without loading the credential chain", async () => {
    const loadCredentialProvider = vi.fn();

    await expect(
      hasAwsCredentials(
        {
          AWS_ACCESS_KEY_ID: "access-key",
          AWS_SECRET_ACCESS_KEY: "secret-key",
        },
        loadCredentialProvider,
      ),
    ).resolves.toBe(true);

    expect(loadCredentialProvider).not.toHaveBeenCalled();
  });

  it("accepts the Bedrock bearer token without loading the credential chain", async () => {
    const loadCredentialProvider = vi.fn();

    await expect(
      hasAwsCredentials(
        {
          AWS_BEARER_TOKEN_BEDROCK: "bearer-token",
        },
        loadCredentialProvider,
      ),
    ).resolves.toBe(true);

    expect(loadCredentialProvider).not.toHaveBeenCalled();
  });

  it("requires AWS profile credentials to resolve through the credential chain", async () => {
    const loadCredentialProvider = vi.fn().mockResolvedValue({
      defaultProvider: () => async () => ({ accessKeyId: "resolved-access-key" }),
    });

    await expect(hasAwsCredentials({ AWS_PROFILE: "work" }, loadCredentialProvider)).resolves.toBe(
      true,
    );

    expect(loadCredentialProvider).toHaveBeenCalledOnce();
  });

  it("rejects AWS profile markers when the credential chain cannot resolve", async () => {
    const loadCredentialProvider = vi.fn().mockResolvedValue({
      defaultProvider: () => async () => {
        throw new Error("Could not load credentials from any providers");
      },
    });

    await expect(
      hasAwsCredentials({ AWS_PROFILE: "missing" }, loadCredentialProvider),
    ).resolves.toBe(false);
  });

  it("returns false when the AWS credential provider package is unavailable", async () => {
    const loadCredentialProvider = vi.fn().mockResolvedValue(null);

    await expect(hasAwsCredentials({}, loadCredentialProvider)).resolves.toBe(false);
  });

  it("skips the credential chain when no AWS probe signals are present (#64891)", async () => {
    const loadCredentialProvider = vi.fn();

    await expect(hasAwsCredentials({}, loadCredentialProvider)).resolves.toBe(false);

    expect(loadCredentialProvider).not.toHaveBeenCalled();
  });

  it("returns false immediately when AWS_EC2_METADATA_DISABLED is set without probe signals", async () => {
    const loadCredentialProvider = vi.fn();

    await expect(
      hasAwsCredentials({ AWS_EC2_METADATA_DISABLED: "true" }, loadCredentialProvider),
    ).resolves.toBe(false);

    expect(loadCredentialProvider).not.toHaveBeenCalled();
  });

  it("preserves the default credential chain for explicit Bedrock configs", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const defaultProvider = vi.fn(() => async () => {
      expect(env.AWS_EC2_METADATA_DISABLED).toBeUndefined();
      return { accessKeyId: "resolved-access-key" };
    });
    const loadCredentialProvider = vi.fn().mockResolvedValue({ defaultProvider });

    await expect(hasAwsCredentials(env, loadCredentialProvider, { allowImds: true })).resolves.toBe(
      true,
    );

    expect(defaultProvider).toHaveBeenCalledOnce();
  });

  it("disables IMDS during defaultProvider probing and restores env", async () => {
    const env = { AWS_PROFILE: "work" } as NodeJS.ProcessEnv;
    const defaultProvider = vi.fn(() => async () => {
      expect(env.AWS_EC2_METADATA_DISABLED).toBe("true");
      return { accessKeyId: "resolved-access-key" };
    });
    const loadCredentialProvider = vi.fn().mockResolvedValue({ defaultProvider });

    await expect(hasAwsCredentials(env, loadCredentialProvider)).resolves.toBe(true);

    expect(env.AWS_EC2_METADATA_DISABLED).toBeUndefined();
    expect(defaultProvider).toHaveBeenCalledOnce();
  });

  it("memoizes process.env credential probes and coalesces concurrent calls", async () => {
    const defaultProvider = vi.fn(() => async () => ({ accessKeyId: "resolved-access-key" }));
    const loadCredentialProvider = vi.fn().mockResolvedValue({ defaultProvider });
    const previousProfile = process.env.AWS_PROFILE;
    process.env.AWS_PROFILE = "work";

    try {
      const [first, second] = await Promise.all([
        hasAwsCredentials(process.env, loadCredentialProvider),
        hasAwsCredentials(process.env, loadCredentialProvider),
      ]);

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(loadCredentialProvider).toHaveBeenCalledOnce();
      expect(defaultProvider).toHaveBeenCalledOnce();
    } finally {
      if (previousProfile === undefined) {
        delete process.env.AWS_PROFILE;
      } else {
        process.env.AWS_PROFILE = previousProfile;
      }
      testing.resetAwsCredentialProbeCacheForTesting();
    }
  });

  it("keeps IMDS enabled when explicit Bedrock probing allows it", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const defaultProvider = vi.fn(() => async () => {
      expect(env.AWS_EC2_METADATA_DISABLED).toBeUndefined();
      return { accessKeyId: "imds-access-key" };
    });
    const loadCredentialProvider = vi.fn().mockResolvedValue({ defaultProvider });

    await expect(hasAwsCredentials(env, loadCredentialProvider, { allowImds: true })).resolves.toBe(
      true,
    );

    expect(defaultProvider).toHaveBeenCalledOnce();
  });
});

describe("bedrock embedding response parsers", () => {
  it("wraps malformed single embedding JSON", () => {
    expect(() => testing.parseSingle("titan-v2", "{not json")).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("wraps malformed batch embedding JSON", () => {
    expect(() => testing.parseCohereBatch("cohere-v3", "{not json")).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("rejects non-object embedding JSON", () => {
    expect(() => testing.parseSingle("titan-v2", "[]")).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("rejects missing single embedding vectors", () => {
    expect(() => testing.parseSingle("titan-v2", "{}")).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("rejects wrong single embedding vector element types", () => {
    expect(() => testing.parseSingle("titan-v2", '{"embedding":[1,"bad"]}')).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("rejects missing batch embedding vectors", () => {
    expect(() => testing.parseCohereBatch("cohere-v3", "{}")).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("rejects wrong batch embedding vector shapes", () => {
    expect(() =>
      testing.parseCohereBatch("cohere-v3", '{"embeddings":[[1],{"bad":true}]}'),
    ).toThrow("Amazon Bedrock embedding response returned malformed JSON");
  });
});

describe("stripInferenceProfilePrefix", () => {
  it("strips global prefix", () => {
    expect(testing.stripInferenceProfilePrefix("global.cohere.embed-v4:0")).toBe(
      "cohere.embed-v4:0",
    );
  });

  it("strips us prefix", () => {
    expect(testing.stripInferenceProfilePrefix("us.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("strips eu prefix", () => {
    expect(testing.stripInferenceProfilePrefix("eu.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("strips ap prefix", () => {
    expect(testing.stripInferenceProfilePrefix("ap.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("strips apac prefix", () => {
    expect(testing.stripInferenceProfilePrefix("apac.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("strips au prefix", () => {
    expect(testing.stripInferenceProfilePrefix("au.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("strips jp prefix", () => {
    expect(testing.stripInferenceProfilePrefix("jp.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("returns unchanged model ID without prefix", () => {
    expect(testing.stripInferenceProfilePrefix("cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("returns unchanged model ID for amazon.titan-embed-text-v2:0", () => {
    expect(testing.stripInferenceProfilePrefix("amazon.titan-embed-text-v2:0")).toBe(
      "amazon.titan-embed-text-v2:0",
    );
  });
});
