import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearKeyringCaches, KEYRING_SCHEMA } from "../infra/agentshield-keyring.js";
import { clearRevocationsCache } from "../infra/agentshield-revocations.js";
import { clearTrustEnforcementConfigCache } from "../infra/agentshield-trust-config.js";
import { wrapToolWithAgentShieldTrust, __testing } from "./pi-tools.agentshield-trust.js";
import type { AnyAgentTool } from "./tools/common.js";

const { resolveAgentShieldTrustContext, formatTrustHint } = __testing;

function makeTool(result: unknown): AnyAgentTool {
  return {
    name: "test_tool",
    description: "test tool",
    parameters: { type: "object", properties: {} },
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as AnyAgentTool;
}

// ── Environment helpers ──

const ENV_KEYS = [
  "AGENTSHIELD_TRUST_ROOT",
  "AGENTSHIELD_REVOCATIONS_FILE",
  "AGENTSHIELD_REQUIRE_KEYRING",
  "AGENTSHIELD_REQUIRE_NOT_REVOKED",
  "AGENTSHIELD_PUBLISHER_ID",
  "AGENTSHIELD_TRUSTCARD_PATH",
];

function backupAndClearEnv(): Record<string, string | undefined> {
  const backup: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    backup[key] = process.env[key];
    delete process.env[key];
  }
  return backup;
}

function restoreEnv(backup: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    if (backup[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = backup[key];
    }
  }
}

// ── Test fixtures ──

function writeRevocations(dir: string, revocations: object) {
  const filePath = path.join(dir, "revocations.json");
  fs.writeFileSync(filePath, JSON.stringify(revocations, null, 2));
  return filePath;
}

function writeKeyring(trustRoot: string, publisherId: string, keyring: object) {
  const pubDir = path.join(trustRoot, "publishers", publisherId);
  fs.mkdirSync(pubDir, { recursive: true });
  fs.writeFileSync(path.join(pubDir, "keyring.json"), JSON.stringify(keyring, null, 2));
}

// ── resolveAgentShieldTrustContext ──

describe("resolveAgentShieldTrustContext", () => {
  let tempDir: string;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    envBackup = backupAndClearEnv();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-ctx-test-"));
  });

  afterEach(() => {
    restoreEnv(envBackup);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty context when no agentDir and no env vars", () => {
    const ctx = resolveAgentShieldTrustContext({});
    expect(ctx.publisherId).toBeUndefined();
    expect(ctx.signedTrustCard).toBeUndefined();
  });

  it("probes trust_card.json in agentDir", () => {
    const card = { publisher_id: "pub-1", id: "card-1", content_sha256: "abc123" };
    fs.writeFileSync(path.join(tempDir, "trust_card.json"), JSON.stringify(card));

    const ctx = resolveAgentShieldTrustContext({ agentDir: tempDir });
    expect(ctx.publisherId).toBe("pub-1");
    expect(ctx.trustCardId).toBe("card-1");
    expect(ctx.contentSha256).toBe("abc123");
    expect(ctx.signedTrustCard).toBeUndefined();
  });

  it("probes trust-card.json when trust_card.json is absent", () => {
    const card = { publisherId: "pub-2" };
    fs.writeFileSync(path.join(tempDir, "trust-card.json"), JSON.stringify(card));

    const ctx = resolveAgentShieldTrustContext({ agentDir: tempDir });
    expect(ctx.publisherId).toBe("pub-2");
  });

  it("probes .agentshield/trust_card.json", () => {
    const subDir = path.join(tempDir, ".agentshield");
    fs.mkdirSync(subDir, { recursive: true });
    const card = { publisher_id: "pub-3" };
    fs.writeFileSync(path.join(subDir, "trust_card.json"), JSON.stringify(card));

    const ctx = resolveAgentShieldTrustContext({ agentDir: tempDir });
    expect(ctx.publisherId).toBe("pub-3");
  });

  it("parses signed envelope", () => {
    const envelope = {
      payload: { publisher_id: "pub-signed", trust_card_id: "tc-1", sha256: "deadbeef" },
      signature: "sig-hex",
      public_key: "pk-hex",
    };
    fs.writeFileSync(path.join(tempDir, "trust_card.json"), JSON.stringify(envelope));

    const ctx = resolveAgentShieldTrustContext({ agentDir: tempDir });
    expect(ctx.publisherId).toBe("pub-signed");
    expect(ctx.signedTrustCard).toEqual(envelope);
    expect(ctx.trustCardId).toBe("tc-1");
    expect(ctx.contentSha256).toBe("deadbeef");
  });

  it("uses AGENTSHIELD_TRUSTCARD_PATH env var override", () => {
    const customPath = path.join(tempDir, "custom-card.json");
    const card = { publisher_id: "pub-env" };
    fs.writeFileSync(customPath, JSON.stringify(card));
    process.env.AGENTSHIELD_TRUSTCARD_PATH = customPath;

    const ctx = resolveAgentShieldTrustContext({});
    expect(ctx.publisherId).toBe("pub-env");
  });

  it("uses AGENTSHIELD_PUBLISHER_ID as fallback when no trust card", () => {
    process.env.AGENTSHIELD_PUBLISHER_ID = "pub-fallback";

    const ctx = resolveAgentShieldTrustContext({});
    expect(ctx.publisherId).toBe("pub-fallback");
  });

  it("trust card publisherId takes precedence over env var", () => {
    process.env.AGENTSHIELD_PUBLISHER_ID = "pub-env";
    const card = { publisher_id: "pub-file" };
    fs.writeFileSync(path.join(tempDir, "trust_card.json"), JSON.stringify(card));

    const ctx = resolveAgentShieldTrustContext({ agentDir: tempDir });
    expect(ctx.publisherId).toBe("pub-file");
  });

  it("handles invalid JSON gracefully", () => {
    fs.writeFileSync(path.join(tempDir, "trust_card.json"), "not-json{{{");

    const ctx = resolveAgentShieldTrustContext({ agentDir: tempDir });
    // Should not throw, just return empty
    expect(ctx.publisherId).toBeUndefined();
  });
});

// ── wrapToolWithAgentShieldTrust — revocation enforcement ──

describe("wrapToolWithAgentShieldTrust — revocation enforcement", () => {
  let tempDir: string;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    envBackup = backupAndClearEnv();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-wrap-test-"));
    process.env.AGENTSHIELD_TRUST_ROOT = tempDir;
    process.env.AGENTSHIELD_REVOCATIONS_FILE = path.join(tempDir, "revocations.json");
    process.env.AGENTSHIELD_REQUIRE_NOT_REVOKED = "1";
    clearRevocationsCache();
    clearKeyringCaches();
    clearTrustEnforcementConfigCache();
  });

  afterEach(() => {
    restoreEnv(envBackup);
    fs.rmSync(tempDir, { recursive: true, force: true });
    clearRevocationsCache();
    clearKeyringCaches();
    clearTrustEnforcementConfigCache();
  });

  it("blocks tool call when publisher is revoked", async () => {
    writeRevocations(tempDir, {
      type: "agentshield.revocations",
      schema: "agentshield.revocation_list.v1",
      issued_at: "2025-01-01T00:00:00Z",
      publisher_id: "test-publisher",
      revocations: [
        {
          kind: "pubkey",
          id: "bad-publisher",
          reason: "compromised key",
          revoked_at: "2025-01-01T00:00:00Z",
        },
      ],
      signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
    });

    const tool = makeTool({ ok: true });
    const wrapped = wrapToolWithAgentShieldTrust(tool, {
      agentId: "agent-1",
      publisherId: "bad-publisher",
    });

    const result = await wrapped.execute("call-1", {}, undefined, undefined);
    const content = result?.content?.[0];
    expect(content).toBeDefined();
    const parsed = JSON.parse((content as { text: string }).text);
    expect(parsed.status).toBe("blocked");
    expect(parsed.reason).toContain("revoked");
    // Original tool should NOT have been called
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("allows tool call when publisher is not revoked", async () => {
    writeRevocations(tempDir, {
      type: "agentshield.revocations",
      schema: "agentshield.revocation_list.v1",
      issued_at: "2025-01-01T00:00:00Z",
      publisher_id: "test-publisher",
      revocations: [],
      signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
    });

    const tool = makeTool({ ok: true });
    const wrapped = wrapToolWithAgentShieldTrust(tool, {
      agentId: "agent-1",
      publisherId: "good-publisher",
    });

    await wrapped.execute("call-1", {}, undefined, undefined);
    expect(tool.execute).toHaveBeenCalledOnce();
  });
});

// ── wrapToolWithAgentShieldTrust — keyring enforcement ──

describe("wrapToolWithAgentShieldTrust — keyring enforcement", () => {
  let tempDir: string;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    envBackup = backupAndClearEnv();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-keyring-test-"));
    process.env.AGENTSHIELD_TRUST_ROOT = tempDir;
    process.env.AGENTSHIELD_REQUIRE_KEYRING = "1";
    clearRevocationsCache();
    clearKeyringCaches();
    clearTrustEnforcementConfigCache();
  });

  afterEach(() => {
    restoreEnv(envBackup);
    fs.rmSync(tempDir, { recursive: true, force: true });
    clearRevocationsCache();
    clearKeyringCaches();
    clearTrustEnforcementConfigCache();
  });

  it("blocks tool call when signerPubkey is not in keyring", async () => {
    writeKeyring(tempDir, "test-pub", {
      schema: KEYRING_SCHEMA,
      publisher_id: "test-pub",
      keys: [
        {
          key_id: "k1",
          alg: "ed25519",
          pubkey: "known-key-hex",
          status: "active",
          created_at: "2025-01-01T00:00:00Z",
        },
      ],
    });

    const tool = makeTool({ ok: true });
    const wrapped = wrapToolWithAgentShieldTrust(tool, {
      agentId: "agent-1",
      publisherId: "test-pub",
      signerPubkey: "unknown-key-hex",
    });

    const result = await wrapped.execute("call-1", {}, undefined, undefined);
    const content = result?.content?.[0];
    expect(content).toBeDefined();
    const parsed = JSON.parse((content as { text: string }).text);
    expect(parsed.status).toBe("blocked");
    expect(parsed.reason).toContain("keyring");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("allows tool call when signerPubkey is active in keyring", async () => {
    writeKeyring(tempDir, "test-pub", {
      schema: KEYRING_SCHEMA,
      publisher_id: "test-pub",
      keys: [
        {
          key_id: "k1",
          alg: "ed25519",
          pubkey: "active-key-hex",
          status: "active",
          created_at: "2025-01-01T00:00:00Z",
        },
      ],
    });

    const tool = makeTool({ ok: true });
    const wrapped = wrapToolWithAgentShieldTrust(tool, {
      agentId: "agent-1",
      publisherId: "test-pub",
      signerPubkey: "active-key-hex",
    });

    await wrapped.execute("call-1", {}, undefined, undefined);
    expect(tool.execute).toHaveBeenCalledOnce();
  });
});

// ── formatTrustHint ──

describe("formatTrustHint", () => {
  it("returns generic hint when no paths", () => {
    const hint = formatTrustHint(null, null);
    expect(hint).toContain("Check AgentShield");
  });

  it("includes trust root path", () => {
    const hint = formatTrustHint("/path/to/root", null);
    expect(hint).toContain("/path/to/root");
  });

  it("includes both paths", () => {
    const hint = formatTrustHint("/root", "/revocations.json");
    expect(hint).toContain("/root");
    expect(hint).toContain("/revocations.json");
  });
});

// ── Disabled enforcement ──

describe("wrapToolWithAgentShieldTrust — disabled", () => {
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    envBackup = backupAndClearEnv();
    clearTrustEnforcementConfigCache();
  });

  afterEach(() => {
    restoreEnv(envBackup);
    clearTrustEnforcementConfigCache();
  });

  it("returns tool unchanged when trust enforcement is disabled", () => {
    const tool = makeTool({ ok: true });
    const wrapped = wrapToolWithAgentShieldTrust(tool, { publisherId: "test" });
    // When disabled, the wrapper returns the original tool object
    expect(wrapped).toBe(tool);
  });
});
