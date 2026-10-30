import { describe, expect, it } from "vitest";
import { parseInspectJson } from "./crabbox-worker-inspect.js";

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: "cbx_012345abcdef", state: "RUNNING", ...overrides });
}

describe("Crabbox worker inspect", () => {
  it("projects lifecycle and account facts without retaining SSH transport secrets", () => {
    expect(
      parseInspectJson(
        inspectJson({
          providerMetadata: { instanceProfileAttached: false },
          ready: true,
          sshHost: "worker.example.test",
          sshPort: 2222,
          sshKey: "/tmp/provider-owned-key",
          sshUser: "desktop-user",
        }),
      ),
    ).toStrictEqual({
      id: "cbx_012345abcdef",
      state: "running",
      tailscaleEnabled: false,
      awsInstanceProfileAttached: false,
      ready: true,
      sshUser: "desktop-user",
    });
  });

  it.each([undefined, "", "   ", "<token>"])("does not invent an account from %s", (sshUser) => {
    expect(parseInspectJson(inspectJson({ sshUser })).sshUser).toBeUndefined();
  });

  it.each([
    { cleanupStartedAt: "2026-10-30T00:00:00Z" },
    { cleanupError: "provider cleanup failed" },
    { cleanupRetryAt: "2026-10-30T00:01:00Z" },
    { releaseDeletesServer: false },
    { releaseDeletesServer: "true" },
    { cleanupError: null },
  ])("does not confirm incomplete or retained release %j", (pending) => {
    expect(
      parseInspectJson(inspectJson({ state: "released", serverId: "0", ...pending }))
        .releaseConfirmed,
    ).not.toBe(true);
  });

  it("retains only effective lifetime policy fields and sanitizes notices", () => {
    const parsed = parseInspectJson(
      inspectJson({
        expiresAt: "2026-10-13T12:30:00Z",
        idleTimeout: "10s",
        maxLifetime: "4h",
        leasePolicy: { runtimeExtension: false, extension: "deny" },
        policyNotice: "clamped\nAuthorization: Bearer super-secret-token",
        labels: { created_at: "1791892800", ttl_secs: "1800", private: "secret" },
        sshKey: "/private/key",
        lifetimePolicy: { mode: "retained", deadlineAt: "2099-01-01" },
      }),
    );
    expect(parsed.lifetime).toMatchObject({
      expiresAtMs: Date.parse("2026-10-13T12:30:00Z"),
      idleTimeoutMs: 10000,
      maxLifetimeMs: 14400000,
      runtimeExtension: false,
      extension: "deny",
      ttlMs: 1800000,
    });
    expect(JSON.stringify(parsed)).not.toContain("super-secret-token");
    expect(parsed).not.toHaveProperty("lifetimePolicy");
    expect(parsed).not.toHaveProperty("labels");
  });
});
