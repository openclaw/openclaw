import { describe, expect, it } from "vitest";
import { generateChutesPkce, parseOAuthCallbackInput } from "./chutes-oauth.js";

describe("parseOAuthCallbackInput", () => {
  const EXPECTED_STATE = "abc123def456";

  it("returns code and state for valid URL with matching state", () => {
    const result = parseOAuthCallbackInput(
      `http://localhost/cb?code=authcode_xyz&state=${EXPECTED_STATE}`,
      EXPECTED_STATE,
    );
    expect(result).toEqual({ code: "authcode_xyz", state: EXPECTED_STATE });
  });

  it("rejects URL with mismatched state (CSRF protection)", () => {
    const result = parseOAuthCallbackInput(
      "http://localhost/cb?code=authcode_xyz&state=attacker_state",
      EXPECTED_STATE,
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/state mismatch/i);
  });

  it("accepts bare code input for manual flow", () => {
    const result = parseOAuthCallbackInput("bare_auth_code", EXPECTED_STATE);
    expect(result).toEqual({ code: "bare_auth_code", state: EXPECTED_STATE });
  });

  it("rejects empty input", () => {
    const result = parseOAuthCallbackInput("", EXPECTED_STATE);
    expect(result).toEqual({ error: "No input provided" });
  });

  it("rejects URL missing code parameter", () => {
    const result = parseOAuthCallbackInput(
      `http://localhost/cb?state=${EXPECTED_STATE}`,
      EXPECTED_STATE,
    );
    expect(result).toHaveProperty("error");
  });

  it("rejects URL missing state parameter", () => {
    const result = parseOAuthCallbackInput("http://localhost/cb?code=authcode_xyz", EXPECTED_STATE);
    expect(result).toHaveProperty("error");
  });
});

describe("generateChutesPkce", () => {
  it("returns verifier and challenge strings", () => {
    const pkce = generateChutesPkce();
    expect(pkce.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(pkce.challenge).toBeTruthy();
  });
});
