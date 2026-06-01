import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import type { BrowserActRequest } from "./client-actions.types.js";
import { redactKnownSecrets, resolveEnvInActRequest } from "./env-secrets.js";

// Uses the default env provider alias ("default") with an explicit allowlist.
function configWithAllowlist(allowlist: string[]): OpenClawConfig {
  return {
    secrets: { providers: { default: { source: "env", allowlist } } },
  } as unknown as OpenClawConfig;
}

describe("resolveEnvInActRequest", () => {
  beforeEach(() => {
    process.env.TEST_ENV_USER = "alice";
    process.env.TEST_ENV_PW = "s3cret-value";
  });
  afterEach(() => {
    delete process.env.TEST_ENV_USER;
    delete process.env.TEST_ENV_PW;
  });

  it("substitutes {{env:KEY}} in type text", async () => {
    const out = await resolveEnvInActRequest(
      { kind: "type", text: "{{env:TEST_ENV_USER}}" } as BrowserActRequest,
      configWithAllowlist(["TEST_ENV_USER"]),
    );
    expect(out).toMatchObject({ kind: "type", text: "alice" });
  });

  it("substitutes inside fill field values and select values", async () => {
    const filled = await resolveEnvInActRequest(
      {
        kind: "fill",
        fields: [{ ref: "e1", type: "text", value: "user={{env:TEST_ENV_USER}}" }],
      } as BrowserActRequest,
      configWithAllowlist(["TEST_ENV_USER"]),
    );
    expect((filled as { fields: { value: string }[] }).fields[0].value).toBe("user=alice");

    const selected = await resolveEnvInActRequest(
      { kind: "select", values: ["{{env:TEST_ENV_USER}}"] } as BrowserActRequest,
      configWithAllowlist(["TEST_ENV_USER"]),
    );
    expect((selected as { values: string[] }).values[0]).toBe("alice");
  });

  it("recurses into batch actions", async () => {
    const out = await resolveEnvInActRequest(
      {
        kind: "batch",
        actions: [{ kind: "type", text: "{{env:TEST_ENV_PW}}" }],
      } as BrowserActRequest,
      configWithAllowlist(["TEST_ENV_PW"]),
    );
    expect((out as { actions: { text: string }[] }).actions[0].text).toBe("s3cret-value");
  });

  it("fails closed when the variable is not allowlisted", async () => {
    await expect(
      resolveEnvInActRequest(
        { kind: "type", text: "{{env:TEST_ENV_PW}}" } as BrowserActRequest,
        configWithAllowlist(["TEST_ENV_USER"]),
      ),
    ).rejects.toThrow(/allowlist/i);
  });

  it("returns the request untouched when there is no placeholder", async () => {
    const req = { kind: "type", text: "literal text" } as BrowserActRequest;
    const out = await resolveEnvInActRequest(req, configWithAllowlist([]));
    expect(out).toBe(req);
  });

  it("redacts resolved secret values from later text (e.g. snapshots)", async () => {
    await resolveEnvInActRequest(
      { kind: "type", text: "{{env:TEST_ENV_PW}}" } as BrowserActRequest,
      configWithAllowlist(["TEST_ENV_PW"]),
    );
    expect(redactKnownSecrets("the field shows s3cret-value now")).toBe(
      "the field shows •••••• now",
    );
  });
});
