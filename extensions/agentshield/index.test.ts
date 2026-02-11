import { describe, it, expect, afterEach } from "vitest";
import { __testing } from "./index.js";

const { isEnabled, resolveMode, resolveToolFilter } = __testing;

describe("isEnabled", () => {
  const original = process.env.AGENTSHIELD_APPROVALS_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGENTSHIELD_APPROVALS_ENABLED;
    } else {
      process.env.AGENTSHIELD_APPROVALS_ENABLED = original;
    }
  });

  it("returns true when env is 1", () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "1";
    expect(isEnabled()).toBe(true);
  });

  it("returns false when env is unset", () => {
    delete process.env.AGENTSHIELD_APPROVALS_ENABLED;
    expect(isEnabled()).toBe(false);
  });

  it("returns false when env is 0", () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "0";
    expect(isEnabled()).toBe(false);
  });

  it("returns false when env is true (only '1' enables)", () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "true";
    expect(isEnabled()).toBe(false);
  });
});

describe("resolveMode", () => {
  const original = process.env.AGENTSHIELD_MODE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGENTSHIELD_MODE;
    } else {
      process.env.AGENTSHIELD_MODE = original;
    }
  });

  it("defaults to 'all' when unset", () => {
    delete process.env.AGENTSHIELD_MODE;
    expect(resolveMode()).toBe("all");
  });

  it("returns 'selective' when set", () => {
    process.env.AGENTSHIELD_MODE = "selective";
    expect(resolveMode()).toBe("selective");
  });

  it("normalizes case", () => {
    process.env.AGENTSHIELD_MODE = "SELECTIVE";
    expect(resolveMode()).toBe("selective");
  });

  it("returns 'all' for unknown values", () => {
    process.env.AGENTSHIELD_MODE = "unknown";
    expect(resolveMode()).toBe("all");
  });
});

describe("resolveToolFilter", () => {
  const original = process.env.AGENTSHIELD_TOOLS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGENTSHIELD_TOOLS;
    } else {
      process.env.AGENTSHIELD_TOOLS = original;
    }
  });

  it("returns null when unset", () => {
    delete process.env.AGENTSHIELD_TOOLS;
    expect(resolveToolFilter()).toBeNull();
  });

  it("returns null for empty string", () => {
    process.env.AGENTSHIELD_TOOLS = "  ";
    expect(resolveToolFilter()).toBeNull();
  });

  it("parses comma-separated tools", () => {
    process.env.AGENTSHIELD_TOOLS = "exec, Read, write";
    const filter = resolveToolFilter();
    expect(filter).not.toBeNull();
    expect(filter!.has("exec")).toBe(true);
    expect(filter!.has("read")).toBe(true);
    expect(filter!.has("write")).toBe(true);
  });

  it("deduplicates entries", () => {
    process.env.AGENTSHIELD_TOOLS = "exec,exec,EXEC";
    const filter = resolveToolFilter();
    expect(filter!.size).toBe(1);
  });
});
