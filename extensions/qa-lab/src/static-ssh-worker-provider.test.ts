import type { WorkerProfile } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { createStaticSshWorkerProvider } from "./static-ssh-worker-provider.js";

const provider = createStaticSshWorkerProvider();
const KEY_REF = {
  source: "file" as const,
  provider: "default",
  id: "/cloud-workers/development/private-key",
};
const HOST_KEY = ["ssh-ed25519", "AAAA"].join(" ");
const PROFILE = {
  host: "worker.example.test",
  user: "openclaw",
  hostKey: HOST_KEY,
  keyRef: KEY_REF,
};
const authority = { assertCurrent: () => {} };
const invalid = (label: string, overrides: WorkerProfile) => ({
  label,
  profile: { ...PROFILE, ...overrides },
});

describe("QA Lab static-SSH worker provider", () => {
  it("provisions a deterministic logical lease with the default SSH port", async () => {
    const profile = {
      ...PROFILE,
      host: " worker.example.test ",
      user: " openclaw ",
      hostKey: ` ${HOST_KEY} `,
    };

    const first = await provider.provision(profile, "operation-123", authority);
    const replay = await provider.provision(profile, "operation-123", authority);

    expect(provider.id).toBe("static-ssh");
    expect(provider.supportedExecutionModes).toEqual(["remote-exec"]);
    expect(first).toStrictEqual({
      leaseId: "static-ssh:operation-123",
      sharedHost: true,
      ssh: {
        host: "worker.example.test",
        port: 22,
        user: "openclaw",
        hostKey: HOST_KEY,
        keyRef: KEY_REF,
      },
    });
    expect(replay).toStrictEqual(first);
    // Cleanup needs only the logical operation identity, even without usable SSH settings.
    const allocation = await provider.resolveAllocation({}, "operation-123");
    expect(allocation).toEqual({ leaseId: first.leaseId, sharedHost: true });
    await expect(
      provider.destroy({ leaseId: allocation.leaseId, profile: {} }),
    ).resolves.toBeUndefined();
  });

  it("preserves an explicit positive SSH port", async () => {
    await expect(
      provider.provision({ ...PROFILE, port: 2222 }, "operation-456", authority),
    ).resolves.toMatchObject({ ssh: { port: 2222 } });
  });

  it.each<{ label: string; profile: WorkerProfile }>([
    invalid("host", { host: " " }),
    invalid("user", { user: "" }),
    invalid("port", { port: 0 }),
    invalid("port", { port: 1.5 }),
    invalid("port", { port: 65_536 }),
    invalid("keyRef", { keyRef: "plaintext-key" }),
    {
      label: "keyRef",
      profile: { host: PROFILE.host, user: PROFILE.user, hostKey: PROFILE.hostKey },
    },
    invalid("keyRef", { keyRef: { source: "file", provider: "", id: "/private-key" } }),
    invalid("keyRef", { keyRef: { source: "file", provider: "default", id: "private-key" } }),
    invalid("keyRef", { keyRef: { source: "env", provider: "default", id: "lowercase" } }),
    invalid("keyRef", { keyRef: { source: "exec", provider: "vault", id: "../private-key" } }),
    {
      label: "hostKey",
      profile: { host: PROFILE.host, user: PROFILE.user, keyRef: PROFILE.keyRef },
    },
    invalid("hostKey", { hostKey: " " }),
    invalid("hostKey", { hostKey: 42 }),
    invalid("hostKey", { hostKey: [HOST_KEY, HOST_KEY].join("\n") }),
    invalid("hostKey", { hostKey: ["restrict", HOST_KEY].join(" ") }),
    invalid("hostKey", { hostKey: [HOST_KEY, "comment"].join(" ") }),
    invalid("hostKey", { hostKey: "not-a-key-type AAAA" }),
    invalid("hostKey", { hostKey: "ssh-ed25519 not-base64!" }),
    invalid("hostKey", { hostKey: "ssh-ed25519 A" }),
    invalid("hostKey", { hostKey: [HOST_KEY, "x".repeat(16_384)].join(" ") }),
  ])("rejects an invalid $label", async ({ label, profile }) => {
    const provision = provider.provision(profile, "operation-invalid", authority);
    await expect(provision).rejects.toThrow(label);
    await expect(provision).rejects.toMatchObject({ code: "invalid_profile" });
  });

  it("reports only its deterministic lease ids as active", async () => {
    for (const [leaseId, expected] of [
      ["static-ssh:operation-123", { status: "active", sharedHost: true }],
      ["static-ssh:", { status: "unknown" }],
      ["other:operation-123", { status: "unknown" }],
    ] as const) {
      await expect(provider.inspect({ leaseId, profile: PROFILE })).resolves.toStrictEqual(
        expected,
      );
    }
  });

  it("destroys logical leases idempotently", async () => {
    const lease = { leaseId: "static-ssh:operation-123", profile: PROFILE };
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
  });
});
