// @openclaw/agent-sdk — Unit tests for PR 6: mutation detection + quarantine.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { IntegrityManifest } from "../index.js";
import {
  checkMutation,
  quarantinePackage,
  isQuarantined,
  getQuarantineRecord,
  liftQuarantine,
  isToolAllowedInQuarantine,
  getQuarantineToolAllowlist,
} from "../quarantine/mutation.js";

const TMP = resolve(import.meta.dirname, "..", "__fixtures__", "tmp-mutation");

function setupWorkspace(): string {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  // Create instruction files
  writeFileSync(resolve(TMP, "AGENTS.md"), "Original AGENTS content", "utf8");
  writeFileSync(resolve(TMP, "SOUL.md"), "Original SOUL content", "utf8");
  writeFileSync(resolve(TMP, "USER.md"), "Original USER content", "utf8");
  writeFileSync(resolve(TMP, "HEARTBEAT.md"), "Original HEARTBEAT content", "utf8");
  return TMP;
}

function cleanWorkspace() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
}

function makeIntegrity(workspacePath: string): IntegrityManifest {
  return {
    version: 1,
    algorithm: "sha256",
    package: { name: "test-agent", version: "1.0.0" },
    files: {
      "AGENTS.md":
        "sha256:" +
        require("node:crypto").createHash("sha256").update("Original AGENTS content").digest("hex"),
      "SOUL.md":
        "sha256:" +
        require("node:crypto").createHash("sha256").update("Original SOUL content").digest("hex"),
      "USER.md":
        "sha256:" +
        require("node:crypto").createHash("sha256").update("Original USER content").digest("hex"),
      "HEARTBEAT.md":
        "sha256:" +
        require("node:crypto")
          .createHash("sha256")
          .update("Original HEARTBEAT content")
          .digest("hex"),
    },
    skills: {},
    generatedAt: new Date().toISOString(),
  };
}

// ── Mutation detection ──────────────────────────────────────────────

describe("checkMutation", () => {
  beforeEach(() => {
    setupWorkspace();
  });
  afterEach(() => {
    cleanWorkspace();
  });

  it("returns clean when all files match", () => {
    const integrity = makeIntegrity(TMP);
    const result = checkMutation(integrity, TMP);
    expect(result.clean).toBe(true);
    expect(result.mutated).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
    expect(result.cleanFiles).toHaveLength(4);
  });

  it("detects a modified instruction file", () => {
    const integrity = makeIntegrity(TMP);
    writeFileSync(resolve(TMP, "AGENTS.md"), "TAMPERED CONTENT", "utf8");

    const result = checkMutation(integrity, TMP);
    expect(result.clean).toBe(false);
    expect(result.mutated).toHaveLength(1);
    expect(result.mutated[0].path).toBe("AGENTS.md");
    expect(result.mutated[0].expectedHash).not.toBe(result.mutated[0].actualHash);
  });

  it("detects multiple modified files", () => {
    const integrity = makeIntegrity(TMP);
    writeFileSync(resolve(TMP, "AGENTS.md"), "tampered", "utf8");
    writeFileSync(resolve(TMP, "SOUL.md"), "also tampered", "utf8");

    const result = checkMutation(integrity, TMP);
    expect(result.clean).toBe(false);
    expect(result.mutated).toHaveLength(2);
    expect(result.cleanFiles).toHaveLength(2);
  });

  it("detects missing files", () => {
    const integrity = makeIntegrity(TMP);
    rmSync(resolve(TMP, "AGENTS.md"));

    const result = checkMutation(integrity, TMP);
    expect(result.clean).toBe(false);
    expect(result.missing).toContain("AGENTS.md");
  });

  it("detects both modified and missing files", () => {
    const integrity = makeIntegrity(TMP);
    writeFileSync(resolve(TMP, "AGENTS.md"), "tampered", "utf8");
    rmSync(resolve(TMP, "SOUL.md"));

    const result = checkMutation(integrity, TMP);
    expect(result.mutated).toHaveLength(1);
    expect(result.missing).toHaveLength(1);
    expect(result.cleanFiles).toHaveLength(2);
  });

  it("includes correct hash values in mutation report", () => {
    const integrity = makeIntegrity(TMP);
    writeFileSync(resolve(TMP, "AGENTS.md"), "new content", "utf8");

    const result = checkMutation(integrity, TMP);
    const mutation = result.mutated[0];
    expect(mutation.expectedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(mutation.actualHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(mutation.expectedHash).not.toBe(mutation.actualHash);
  });
});

// ── Quarantine ──────────────────────────────────────────────────────

describe("quarantine", () => {
  beforeEach(() => {
    setupWorkspace();
  });
  afterEach(() => {
    cleanWorkspace();
  });

  it("creates quarantine record on mutation", () => {
    const integrity = makeIntegrity(TMP);
    writeFileSync(resolve(TMP, "AGENTS.md"), "tampered", "utf8");

    const record = quarantinePackage("test-agent", integrity, TMP);
    expect(record.packageName).toBe("test-agent");
    expect(record.mutations).toHaveLength(1);
    expect(record.reason).toContain("modified");
  });

  it("writes quarantine file to workspace", () => {
    const integrity = makeIntegrity(TMP);
    writeFileSync(resolve(TMP, "AGENTS.md"), "tampered", "utf8");

    quarantinePackage("test-agent", integrity, TMP);
    expect(existsSync(resolve(TMP, "agent-sdk-quarantine.json"))).toBe(true);
  });

  it("isQuarantined returns true after quarantine", () => {
    const integrity = makeIntegrity(TMP);
    writeFileSync(resolve(TMP, "AGENTS.md"), "tampered", "utf8");

    quarantinePackage("test-agent", integrity, TMP);
    expect(isQuarantined(TMP)).toBe(true);
  });

  it("isQuarantined returns false when no quarantine", () => {
    expect(isQuarantined(TMP)).toBe(false);
  });

  it("getQuarantineRecord returns the record", () => {
    const integrity = makeIntegrity(TMP);
    writeFileSync(resolve(TMP, "AGENTS.md"), "tampered", "utf8");

    quarantinePackage("test-agent", integrity, TMP);
    const record = getQuarantineRecord(TMP);
    expect(record).not.toBeNull();
    expect(record!.packageName).toBe("test-agent");
    expect(record!.mutations).toHaveLength(1);
  });

  it("getQuarantineRecord returns null when not quarantined", () => {
    expect(getQuarantineRecord(TMP)).toBeNull();
  });

  it("liftQuarantine clears the record", () => {
    const integrity = makeIntegrity(TMP);
    writeFileSync(resolve(TMP, "AGENTS.md"), "tampered", "utf8");

    quarantinePackage("test-agent", integrity, TMP);
    expect(isQuarantined(TMP)).toBe(true);

    const lifted = liftQuarantine(TMP);
    expect(lifted).toBe(true);
    expect(existsSync(resolve(TMP, "agent-sdk-quarantine-lifted.json"))).toBe(true);
  });

  it("liftQuarantine returns false when not quarantined", () => {
    expect(liftQuarantine(TMP)).toBe(false);
  });
});

// ── Quarantine tool restrictions ────────────────────────────────────

describe("quarantine tool restrictions", () => {
  it("allows read-only tools", () => {
    expect(isToolAllowedInQuarantine("read")).toBe(true);
    expect(isToolAllowedInQuarantine("memory_get")).toBe(true);
    expect(isToolAllowedInQuarantine("memory_search")).toBe(true);
  });

  it("blocks dangerous tools", () => {
    expect(isToolAllowedInQuarantine("write")).toBe(false);
    expect(isToolAllowedInQuarantine("edit")).toBe(false);
    expect(isToolAllowedInQuarantine("exec")).toBe(false);
    expect(isToolAllowedInQuarantine("browser")).toBe(false);
    expect(isToolAllowedInQuarantine("web_fetch")).toBe(false);
    expect(isToolAllowedInQuarantine("web_search")).toBe(false);
  });

  it("allowlist is a defined set", () => {
    const allowlist = getQuarantineToolAllowlist();
    expect(allowlist.length).toBeGreaterThan(0);
    expect(allowlist).toContain("read");
    expect(allowlist).not.toContain("exec");
  });
});
