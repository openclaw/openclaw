import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshAwsSharedConfigCacheForBedrock } from "./aws-credential-refresh.js";

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
