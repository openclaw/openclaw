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
    { AWS_ACCESS_KEY_ID: " ", AWS_SECRET_ACCESS_KEY: "secret" },
    { AWS_ACCESS_KEY_ID: "access", AWS_SECRET_ACCESS_KEY: "\t" },
  ])("refreshes shared config when credential environment values are blank", async (env) => {
    await refreshAwsSharedConfigCacheForBedrock(env);

    expect(loadSharedConfigFiles).toHaveBeenCalledOnce();
    expect(loadSharedConfigFiles).toHaveBeenCalledWith({ ignoreCache: true });
  });

  it.each([
    { AWS_BEARER_TOKEN_BEDROCK: "token" },
    { AWS_ACCESS_KEY_ID: "access", AWS_SECRET_ACCESS_KEY: "secret" },
    { AWS_BEDROCK_SKIP_AUTH: "1" },
  ])("does not refresh shared config when credentials are configured", async (env) => {
    await refreshAwsSharedConfigCacheForBedrock(env);

    expect(loadSharedConfigFiles).not.toHaveBeenCalled();
  });
});

describe("sanitizeBlankAwsCredentials", () => {
  afterEach(() => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
  });

  it("clears whitespace-only AWS credential env vars", () => {
    process.env.AWS_ACCESS_KEY_ID = "  ";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    process.env.AWS_SESSION_TOKEN = "token";

    sanitizeBlankAwsCredentials();

    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(process.env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it("does not clear valid static AWS credentials", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKID";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";

    sanitizeBlankAwsCredentials();

    expect(process.env.AWS_ACCESS_KEY_ID).toBe("AKID");
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("secret");
  });

  it("does not throw when no AWS credential env vars are set", () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;

    expect(() => sanitizeBlankAwsCredentials()).not.toThrow();
  });
});
