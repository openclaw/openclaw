import { describe, expect, it } from "vitest";
import {
  renderProviderAwareMissingApiKeyReplyCopy as missingKeyCopy,
  resolveProviderAwareRequestFailureCopy as requestCopy,
} from "./provider-auth-user-copy.js";
import { AUTH_INVALID_TOKEN_USER_TEXT, renderMissingApiKeyReplyCopy } from "./user-copy.js";

const auth = { kind: "reason", reason: "auth" } as const;

describe("provider-aware sign-in copy", () => {
  it("names a known provider and its /login command for a missing credential", () => {
    expect(missingKeyCopy({ provider: " Meta " })).toBe(
      "⚠️ meta isn't signed in yet. Sign in with /login meta or under Models in the OpenClaw app. For now, switch to a working model with /model.",
    );
  });

  it("keeps the generic copy for unsafe ids, OpenAI and a missing provider", () => {
    for (const params of [
      { provider: "openai`\nrm -rf /" },
      { provider: "openai" },
      { provider: "openai", providerGuidance: true },
      { provider: "  " },
      undefined,
    ]) {
      expect(missingKeyCopy(params)).toBe(renderMissingApiKeyReplyCopy(params));
    }
  });

  it("names the provider on a 401 authentication failure and leaves other failures alone", () => {
    expect(
      requestCopy({ classification: auth, facet: null, status: 401, provider: "meta" }),
    ).toEqual({
      code: "provider_authentication_error",
      userMessage:
        "⚠️ Couldn't sign in to meta. Sign in again with /login meta or under Models in the OpenClaw app. For now, switch to a working model with /model.",
    });
    expect(requestCopy({ classification: auth, facet: null, status: 401 })?.userMessage).toBe(
      `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`,
    );
    expect(
      requestCopy({ classification: null, facet: "quota-429", status: 429, provider: "meta" })
        ?.code,
    ).toBe("provider_rate_limit_or_quota_error");
  });
});
