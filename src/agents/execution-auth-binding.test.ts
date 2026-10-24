import { describe, expect, it } from "vitest";
import { sealSecretSentinel } from "../secrets/sentinel.js";
import type { OAuthCredential } from "./auth-profiles/types.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintAuthProfileOwnerShape,
  fingerprintAwsSdkRuntimeOwner,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "./execution-auth-binding.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

type Identity = Partial<OAuthCredential>;

function grant(
  provider: string,
  access: string,
  refresh: string,
  identity: Identity = {},
): OAuthCredential {
  return { type: "oauth", provider, access, refresh, expires: 1, ...identity };
}
function oauth(provider: string, access: string, refresh: string, identity: Identity = {}) {
  return fingerprintAuthProfileCredential({
    profileId: `${provider}:oauth`,
    credential: grant(provider, access, refresh, identity),
  });
}
function resolved(apiKey: string, extra: Partial<ResolvedProviderAuth> = {}) {
  return fingerprintResolvedProviderAuth({
    apiKey,
    source: "profile:openai:bound",
    mode: "api-key",
    ...extra,
  });
}
function aws(env: NodeJS.ProcessEnv) {
  return fingerprintAwsSdkRuntimeOwner({
    provider: "amazon-bedrock",
    backendId: "openclaw",
    auth: { source: "aws-sdk default chain", mode: "aws-sdk" },
    env,
  });
}

describe("execution auth binding fingerprints", () => {
  it.each([
    ["cli-runtime", "cli", "claude-cli", "claude-cli"],
    ["plugin-harness", "embedded", "openai", "codex"],
  ] as const)("requires an executable identity for %s", (kind, runner, provider, backendId) => {
    const fingerprint = (runtimeArtifactFingerprint?: string) =>
      fingerprintOpaqueRuntimeOwner({
        kind,
        runner,
        provider,
        backendId,
        runtimeArtifactFingerprint,
      });
    expect(fingerprint()).toBeUndefined();
    if (kind === "plugin-harness") {
      expect(fingerprint("codex-runtime-v1")).not.toBe(fingerprint("codex-runtime-v2"));
    }
  });

  it("rejects an unresolved static-secret reference", () => {
    expect(
      fingerprintAuthProfileCredential({
        profileId: "openai:bound",
        credential: {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "exec", provider: "default", id: "key" },
        },
      }),
    ).toBeUndefined();
  });

  it("binds a SecretRef profile to the resolved selected value", () => {
    const credential = {
      type: "api_key" as const,
      provider: "openai",
      keyRef: { source: "env" as const, provider: "default", id: "OPENAI_KEY" },
    };
    const fingerprint = (apiKey: string, profileId = "openai:bound") =>
      fingerprintResolvedAuthProfileCredential({
        profileId: "openai:bound",
        credential,
        resolvedAuth: {
          apiKey,
          profileId,
          source: "profile:openai:bound",
          mode: "api-key",
        },
      });

    expect(fingerprint("first-key")).not.toBe(fingerprint("replacement-key"));
    expect(fingerprint("first-key", "openai:other")).toBeUndefined();
    expect(
      fingerprintResolvedAuthProfileCredential({
        profileId: "openai:bound",
        credential,
        resolvedAuth: null,
      }),
    ).toBeUndefined();
  });

  it("keeps identity-bearing OAuth stable across token refreshes", () => {
    const fingerprint = (access: string, refresh: string) =>
      oauth("openai", access, refresh, { accountId: "account-1", email: "User@Example.test" });

    expect(fingerprint("access-a", "refresh-a")).toBe(fingerprint("access-b", "refresh-b"));
  });

  it("invalidates identity-less OAuth when its opaque grant changes", () => {
    const fingerprint = (access: string, refresh: string) => oauth("anthropic", access, refresh);

    expect(fingerprint("access-a", "refresh-a")).not.toBe(fingerprint("access-b", "refresh-b"));
  });

  it("uses stable id-token identity instead of rotating token material", () => {
    const fingerprint = (access: string, subject: string) =>
      oauth("google", access, `refresh-${access}`, {
        idToken: jwt({ sub: subject, email: "user@example.test" }),
      });

    expect(fingerprint("access-a", "subject-1")).toBe(fingerprint("access-b", "subject-1"));
    expect(fingerprint("access-a", "subject-1")).not.toBe(fingerprint("access-a", "subject-2"));
  });

  it("keeps resolved credential fingerprints opaque and stable within one process", () => {
    const fingerprint = (apiKey: string) => resolved(apiKey, { profileId: "openai:bound" });

    const secret = "raw-secret-marker-with-non-hex";
    const first = fingerprint(secret);

    expect(first).toBe(fingerprint(secret));
    expect(first).not.toBe(fingerprint("replacement-secret"));
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain(secret);
  });

  it("fingerprints the same resolved credential identically across resolution sources", () => {
    // Regression #138584: capture and revalidation may use different resolution sources.
    const material = "shared-credential-material";
    const fromEnv = resolved(material, { source: "env: OPENAI_API_KEY" });
    const fromProfile = resolved(material, { profileId: "openai:bound" });
    const fromModelsJson = resolved(material, { source: "models.json" });

    expect(fromEnv).toBeDefined();
    expect(fromEnv).toBe(fromProfile);
    expect(fromEnv).toBe(fromModelsJson);
    expect(fromEnv).not.toBe(
      resolved(material, {
        source: "env: OPENAI_API_KEY",
        mode: "token" as never,
      }),
    );
  });

  it("hashes a sentinel-sealed key the same as its plaintext", () => {
    const secret = "sentinel-unwrapped-credential";
    const sealed = sealSecretSentinel(secret, { label: "model-auth:test" });
    const fromPlaintext = resolved(secret, { source: "env: TEST" });
    const fromSentinel = resolved(sealed, { source: "profile:test" });

    expect(fromPlaintext).toBeDefined();
    expect(fromPlaintext).toBe(fromSentinel);
    // Tampered sentinels must not silently resolve to the wrong credential.
    expect(resolved(`${sealed.slice(0, -4)}AAAA.end`, { source: "env: TEST" })).toBeUndefined();
  });

  it("rejects auth modes without a concrete credential identity", () => {
    expect(
      fingerprintResolvedProviderAuth({ source: "aws-sdk:default-chain", mode: "aws-sdk" }),
    ).toBeUndefined();
  });

  it("keeps an opaque OAuth profile owner stable across runtime token refreshes", () => {
    const fingerprint = (access: string) =>
      fingerprintAuthProfileOwnerShape({
        profileId: "anthropic:cli",
        credential: grant("anthropic", access, `refresh-${access}`, {
          accountId: "account-1",
        }),
      });

    expect(fingerprint("access-a")).toBe(fingerprint("access-b"));
    expect(
      fingerprintAuthProfileOwnerShape({ profileId: "anthropic:missing", credential: undefined }),
    ).toBeUndefined();
  });

  it("binds AWS SDK owners only to concrete bearer and static credentials", () => {
    expect(aws({ AWS_BEARER_TOKEN_BEDROCK: "bearer-a" })).toBe(
      aws({ AWS_BEARER_TOKEN_BEDROCK: "bearer-a" }),
    );
    expect(aws({ AWS_BEARER_TOKEN_BEDROCK: "bearer-a" })).not.toBe(
      aws({ AWS_BEARER_TOKEN_BEDROCK: "bearer-b" }),
    );
    const credentials = { AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "secret-a" };
    expect(aws(credentials)).not.toBe(aws({ ...credentials, AWS_SECRET_ACCESS_KEY: "secret-b" }));
    expect(aws(credentials)).not.toBe(aws({ ...credentials, AWS_ACCESS_KEY_ID: "AKIA2" }));
    expect(aws({ ...credentials, AWS_SESSION_TOKEN: "session-a" })).not.toBe(
      aws({ ...credentials, AWS_SESSION_TOKEN: "session-b" }),
    );
  });

  it("fails closed when the AWS SDK principal cannot be established", () => {
    expect(aws({ AWS_PROFILE: "work" })).toBeUndefined();
    expect(aws({})).toBeUndefined();
    expect(
      aws({
        AWS_PROFILE: "work",
        AWS_ACCESS_KEY_ID: "AKIA1",
        AWS_SECRET_ACCESS_KEY: "secret-a",
      }),
    ).toBeUndefined();
  });
});
