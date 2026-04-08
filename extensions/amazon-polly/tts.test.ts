import { describe, expect, it, vi, afterEach } from "vitest";
import { hasAwsCredentials } from "./tts.js";

describe("hasAwsCredentials", () => {
  const envVars = [
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_BEARER_TOKEN_BEDROCK",
  ];

  afterEach(() => {
    for (const key of envVars) {
      delete process.env[key];
    }
  });

  it("returns false when no AWS env vars are set", () => {
    for (const key of envVars) {
      delete process.env[key];
    }
    expect(hasAwsCredentials()).toBe(false);
  });

  it.each([
    ["AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE"],
    ["AWS_PROFILE", "default"],
    ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/xxx"],
    ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://169.254.170.23/v2/credentials/xxx"],
    ["AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/secrets/token"],
    ["AWS_BEARER_TOKEN_BEDROCK", "eyJhbGciOiJSUzI1NiJ9..."],
  ])("returns true when %s is set", (envVar, value) => {
    process.env[envVar] = value;
    expect(hasAwsCredentials()).toBe(true);
    delete process.env[envVar];
  });
});
