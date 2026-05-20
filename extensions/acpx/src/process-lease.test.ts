import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAcpxProcessLeaseStore,
  OPENCLAW_ACPX_LEASE_ID_ARG,
  OPENCLAW_ACPX_LEASE_ID_ENV,
  OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
  OPENCLAW_GATEWAY_INSTANCE_ID_ENV,
  withAcpxLeaseEnvironment,
  withScrubbedProviderEnv,
  type AcpxProcessLease,
} from "./process-lease.js";

function makeLease(index: number): AcpxProcessLease {
  return {
    leaseId: `lease-${index}`,
    gatewayInstanceId: "gateway-test",
    sessionKey: `agent:codex:acp:${index}`,
    wrapperRoot: "/tmp/openclaw/acpx",
    wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
    rootPid: 1000 + index,
    commandHash: `hash-${index}`,
    startedAt: index,
    state: "open",
  };
}

describe("createAcpxProcessLeaseStore", () => {
  it("serializes concurrent lease saves without dropping records", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-acpx-leases-"));
    try {
      const store = createAcpxProcessLeaseStore({ stateDir });
      await Promise.all(Array.from({ length: 25 }, (_, index) => store.save(makeLease(index))));

      const leases = await store.listOpen("gateway-test");
      expect(leases.map((lease) => lease.leaseId).toSorted()).toEqual(
        Array.from({ length: 25 }, (_, index) => `lease-${index}`).toSorted(),
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("withAcpxLeaseEnvironment", () => {
  it("adds lease environment and wrapper args on POSIX", () => {
    const command = withAcpxLeaseEnvironment({
      command: "node /tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      leaseId: "lease-test",
      gatewayInstanceId: "gateway-test",
      platform: "darwin",
    });

    expect(command).toBe(
      [
        "env",
        `${OPENCLAW_ACPX_LEASE_ID_ENV}=lease-test`,
        `${OPENCLAW_GATEWAY_INSTANCE_ID_ENV}=gateway-test`,
        "node /tmp/openclaw/acpx/codex-acp-wrapper.mjs",
        OPENCLAW_ACPX_LEASE_ID_ARG,
        "lease-test",
        OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
        "gateway-test",
      ].join(" "),
    );
  });

  it("keeps Windows logs keyed by lease id with wrapper args", () => {
    const command = withAcpxLeaseEnvironment({
      command: "node C:/openclaw/acpx/codex-acp-wrapper.mjs",
      leaseId: "lease-test",
      gatewayInstanceId: "gateway-test",
      platform: "win32",
    });

    expect(command).toBe(
      [
        "node C:/openclaw/acpx/codex-acp-wrapper.mjs",
        OPENCLAW_ACPX_LEASE_ID_ARG,
        "lease-test",
        OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
        "gateway-test",
      ].join(" "),
    );
    expect(command).not.toContain(`${OPENCLAW_ACPX_LEASE_ID_ENV}=`);
    expect(command).not.toContain(`${OPENCLAW_GATEWAY_INSTANCE_ID_ENV}=`);
  });
});

describe("withScrubbedProviderEnv", () => {
  it("prepends env -u flags for each credential on POSIX", () => {
    const command = withScrubbedProviderEnv({
      command: 'node "/tmp/openclaw/acpx/claude-agent-acp-wrapper.mjs"',
      unsetKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      platform: "darwin",
    });

    expect(command).toBe(
      'env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN node "/tmp/openclaw/acpx/claude-agent-acp-wrapper.mjs"',
    );
  });

  it("merges into an existing lease env prefix as a single env invocation", () => {
    const leased = withAcpxLeaseEnvironment({
      command: "node /tmp/openclaw/acpx/claude-agent-acp-wrapper.mjs",
      leaseId: "lease-test",
      gatewayInstanceId: "gateway-test",
      platform: "darwin",
    });

    const command = withScrubbedProviderEnv({
      command: leased,
      unsetKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      platform: "darwin",
    });

    // A single `env` invocation — the unset flags merge into the lease prefix
    // rather than nesting a second `env ... env ...`.
    expect(command.match(/(?:^|\s)env\s/g)).toHaveLength(1);
    // Unset flags must precede name=value assignments (POSIX `env` ordering).
    expect(command).toBe(
      [
        "env",
        "-u ANTHROPIC_API_KEY",
        "-u ANTHROPIC_AUTH_TOKEN",
        `${OPENCLAW_ACPX_LEASE_ID_ENV}=lease-test`,
        `${OPENCLAW_GATEWAY_INSTANCE_ID_ENV}=gateway-test`,
        "node /tmp/openclaw/acpx/claude-agent-acp-wrapper.mjs",
        OPENCLAW_ACPX_LEASE_ID_ARG,
        "lease-test",
        OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
        "gateway-test",
      ].join(" "),
    );
  });

  it("de-duplicates repeated credential names", () => {
    const command = withScrubbedProviderEnv({
      command: "claude-agent-acp",
      unsetKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
      platform: "linux",
    });

    expect(command).toBe("env -u ANTHROPIC_API_KEY claude-agent-acp");
  });

  it("is a no-op when there are no keys to strip", () => {
    expect(
      withScrubbedProviderEnv({ command: "claude-agent-acp", unsetKeys: [], platform: "linux" }),
    ).toBe("claude-agent-acp");
  });

  it("is a no-op on Windows where env -u is not portable", () => {
    expect(
      withScrubbedProviderEnv({
        command: "node C:/x/claude-agent-acp-wrapper.mjs",
        unsetKeys: ["ANTHROPIC_API_KEY"],
        platform: "win32",
      }),
    ).toBe("node C:/x/claude-agent-acp-wrapper.mjs");
  });

  // End-to-end proof of the scrub mechanism: a child launched through the
  // decorated command cannot read the stripped provider credentials, even
  // though the parent has them set — while unrelated env vars survive.
  it.skipIf(process.platform === "win32")(
    "removes the named credentials from the spawned child's environment",
    () => {
      const probe =
        "node -e 'process.stdout.write(JSON.stringify({" +
        "a:process.env.ANTHROPIC_API_KEY||null," +
        "t:process.env.ANTHROPIC_AUTH_TOKEN||null," +
        "keep:process.env.OPENCLAW_KEEPME||null}))'";
      const command = withScrubbedProviderEnv({
        command: probe,
        unsetKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
        platform: process.platform,
      });

      const output = execFileSync("sh", ["-c", command], {
        encoding: "utf8",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "sk-ant-oat01-should-be-stripped",
          ANTHROPIC_AUTH_TOKEN: "should-be-stripped-too",
          OPENCLAW_KEEPME: "still-here",
        },
      });

      expect(JSON.parse(output)).toEqual({ a: null, t: null, keep: "still-here" });
    },
  );
});
