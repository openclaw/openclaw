import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  refreshAwsSharedConfigCacheForBedrock,
  sanitizeBlankAwsCredentials,
} from "./aws-credential-refresh.js";

const loadSharedConfigFiles = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("@smithy/shared-ini-file-loader", () => ({ loadSharedConfigFiles }));

describe("refreshAwsSharedConfigCacheForBedrock", () => {
  beforeEach(() => {
    loadSharedConfigFiles.mockClear();
  });

  it.each([
    { AWS_BEARER_TOKEN_BEDROCK: "  " },
    { AWS_ACCESS_KEY_ID: " ", AWS_SECRET_ACCESS_KEY: "test-aws-secret-access-key" },
    { AWS_ACCESS_KEY_ID: "test-access-key-id", AWS_SECRET_ACCESS_KEY: "\t" },
  ])("refreshes shared config when credential environment values are blank", async (env) => {
    await refreshAwsSharedConfigCacheForBedrock(env);

    expect(loadSharedConfigFiles).toHaveBeenCalledOnce();
    expect(loadSharedConfigFiles).toHaveBeenCalledWith({ ignoreCache: true });
  });

  it.each([
    { AWS_BEARER_TOKEN_BEDROCK: "test-aws-bearer-token-bedrock" },
    {
      AWS_ACCESS_KEY_ID: "test-access-key-id",
      AWS_SECRET_ACCESS_KEY: "test-aws-secret-access-key",
    },
    { AWS_BEDROCK_SKIP_AUTH: "1" },
  ])("does not refresh shared config when credentials are configured", async (env) => {
    await refreshAwsSharedConfigCacheForBedrock(env);

    expect(loadSharedConfigFiles).not.toHaveBeenCalled();
  });
});

describe("sanitizeBlankAwsCredentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("clears whitespace-only AWS credential env vars", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "  ");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-aws-secret-access-key");
    vi.stubEnv("AWS_SESSION_TOKEN", "test-aws-session-token");

    sanitizeBlankAwsCredentials();

    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(process.env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it("clears a blank session token without removing valid static keys", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key-id");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-aws-secret-access-key");
    vi.stubEnv("AWS_SESSION_TOKEN", " \t ");

    sanitizeBlankAwsCredentials();

    expect(process.env.AWS_ACCESS_KEY_ID).toBe("test-access-key-id");
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("test-aws-secret-access-key");
    expect(process.env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it("clears a blank Bedrock bearer token without removing valid static keys", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key-id");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-aws-secret-access-key");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", " \t ");

    sanitizeBlankAwsCredentials();

    expect(process.env.AWS_ACCESS_KEY_ID).toBe("test-access-key-id");
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("test-aws-secret-access-key");
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  it("does not clear valid static AWS credentials", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key-id");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-aws-secret-access-key");

    sanitizeBlankAwsCredentials();

    expect(process.env.AWS_ACCESS_KEY_ID).toBe("test-access-key-id");
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("test-aws-secret-access-key");
  });

  it("does not throw when no AWS credential env vars are set", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);

    expect(() => sanitizeBlankAwsCredentials()).not.toThrow();
  });
});
