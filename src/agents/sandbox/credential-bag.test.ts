import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadCredentialBagsFile,
  loadCredentialBagForAgent,
  buildBagEnvArgs,
  type CredentialBagFile,
} from "./credential-bag.js";

let tmpDir: string;
let bagPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "credbag-"));
  bagPath = join(tmpDir, "credential-bags.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function write(file: CredentialBagFile) {
  writeFileSync(bagPath, JSON.stringify(file, null, 2), "utf8");
}

describe("loadCredentialBagsFile", () => {
  it("returns an empty file when the path does not exist", () => {
    const result = loadCredentialBagsFile(join(tmpDir, "missing.json"));
    expect(result).toEqual({ version: 1, bags: [] });
  });

  it("loads a valid bags file", () => {
    write({
      version: 1,
      bags: [{ agentId: "quinn", vars: { ANTHROPIC_API_KEY: "sk-test" } }],
    });
    const result = loadCredentialBagsFile(bagPath);
    expect(result.bags).toHaveLength(1);
    expect(result.bags[0].agentId).toBe("quinn");
  });

  it("throws on malformed JSON", () => {
    writeFileSync(bagPath, "{not valid json", "utf8");
    expect(() => loadCredentialBagsFile(bagPath)).toThrow(/not valid JSON/);
  });

  it("throws on a malformed shape", () => {
    writeFileSync(bagPath, JSON.stringify({ version: 1 }), "utf8");
    expect(() => loadCredentialBagsFile(bagPath)).toThrow(/malformed/);
  });
});

describe("loadCredentialBagForAgent", () => {
  beforeEach(() => {
    write({
      version: 1,
      bags: [
        { agentId: "quinn", vars: { ANTHROPIC_API_KEY: "q-secret" } },
        { agentId: "jack", vars: { HUBSPOT_API_KEY: "j-secret" } },
      ],
    });
  });

  it("returns null for an unknown agent", () => {
    expect(loadCredentialBagForAgent("nobody", bagPath)).toBeNull();
  });

  it("returns the bag for a known agent", () => {
    const bag = loadCredentialBagForAgent("quinn", bagPath);
    expect(bag).not.toBeNull();
    expect(bag!.vars.ANTHROPIC_API_KEY).toBe("q-secret");
  });

  it("is case-insensitive on agentId lookup", () => {
    const bag = loadCredentialBagForAgent("QUINN", bagPath);
    expect(bag).not.toBeNull();
    expect(bag!.agentId).toBe("quinn");
  });

  it("enforces scope isolation between agents", () => {
    const quinn = loadCredentialBagForAgent("quinn", bagPath);
    const jack = loadCredentialBagForAgent("jack", bagPath);
    expect(quinn!.vars.ANTHROPIC_API_KEY).toBe("q-secret");
    expect(jack!.vars.HUBSPOT_API_KEY).toBe("j-secret");
    expect(quinn!.vars).not.toHaveProperty("HUBSPOT_API_KEY");
    expect(jack!.vars).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("returns null for a blank agentId", () => {
    expect(loadCredentialBagForAgent("", bagPath)).toBeNull();
    expect(loadCredentialBagForAgent("   ", bagPath)).toBeNull();
  });
});

describe("buildBagEnvArgs", () => {
  it("returns empty results for a null bag", () => {
    const r = buildBagEnvArgs(null);
    expect(r.args).toEqual([]);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("produces Docker --env flags for every valid entry", () => {
    const r = buildBagEnvArgs({
      agentId: "quinn",
      vars: { FOO: "bar", ANOTHER_KEY: "value" },
    });
    expect(r.args).toEqual([
      "--env",
      "FOO=bar",
      "--env",
      "ANOTHER_KEY=value",
    ]);
    expect(r.applied).toEqual(["FOO", "ANOTHER_KEY"]);
    expect(r.skipped).toEqual([]);
  });

  it("skips empty keys with a reason", () => {
    const r = buildBagEnvArgs({ agentId: "q", vars: { "": "x", FOO: "bar" } });
    expect(r.applied).toEqual(["FOO"]);
    expect(r.skipped).toEqual([{ key: "", reason: "empty key" }]);
  });

  it("skips keys with invalid env var names", () => {
    const r = buildBagEnvArgs({
      agentId: "q",
      vars: { "BAD-NAME": "x", "1LEADING_DIGIT": "y", GOOD: "z" },
    });
    expect(r.applied).toEqual(["GOOD"]);
    expect(r.skipped.map((s) => s.key).sort()).toEqual(["1LEADING_DIGIT", "BAD-NAME"]);
    expect(r.skipped.every((s) => s.reason === "invalid env var name")).toBe(true);
  });

  it("skips values with null bytes", () => {
    const r = buildBagEnvArgs({
      agentId: "q",
      vars: { EVIL: "has\0null", OK: "clean" },
    });
    expect(r.applied).toEqual(["OK"]);
    expect(r.skipped).toEqual([{ key: "EVIL", reason: "contains null bytes" }]);
  });

  it("skips oversized values", () => {
    const r = buildBagEnvArgs({
      agentId: "q",
      vars: { HUGE: "a".repeat(33000), OK: "clean" },
    });
    expect(r.applied).toEqual(["OK"]);
    expect(r.skipped).toEqual([{ key: "HUGE", reason: "value exceeds maximum length" }]);
  });

  it("trims whitespace from keys", () => {
    const r = buildBagEnvArgs({
      agentId: "q",
      vars: { "  PADDED  ": "value" },
    });
    expect(r.applied).toEqual(["PADDED"]);
    expect(r.args).toEqual(["--env", "PADDED=value"]);
  });

  it("skips non-string values", () => {
    const r = buildBagEnvArgs({
      agentId: "q",
      vars: { NUM: 123 as unknown as string, OK: "clean" },
    });
    expect(r.applied).toEqual(["OK"]);
    expect(r.skipped).toEqual([{ key: "NUM", reason: "value is not a string" }]);
  });
});
