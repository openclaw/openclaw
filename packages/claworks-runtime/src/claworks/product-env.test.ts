import { describe, expect, it } from "vitest";
import {
  CLAWORKS_DEFAULT_GATEWAY_PORT,
  detectAndApplyClaworksCli,
  looksLikeClaworksStateEnv,
  warnIfOpenClawEntryWithClaworksState,
} from "./product-env.js";

describe("looksLikeClaworksStateEnv", () => {
  it("detects .claworks state dir", () => {
    expect(looksLikeClaworksStateEnv({ OPENCLAW_STATE_DIR: "/home/user/.claworks" })).toBe(true);
  });

  it("detects claworks.json config path", () => {
    expect(
      looksLikeClaworksStateEnv({
        OPENCLAW_CONFIG_PATH: "/home/user/.claworks/claworks.json",
      }),
    ).toBe(true);
  });

  it("returns false for default OpenClaw paths", () => {
    expect(looksLikeClaworksStateEnv({ OPENCLAW_STATE_DIR: "/home/user/.openclaw" })).toBe(false);
  });
});

describe("detectAndApplyClaworksCli", () => {
  it("infers product mode from ClaWorks state env", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_STATE_DIR: "/tmp/test-claworks-state/.claworks",
    };
    detectAndApplyClaworksCli(env);
    expect(env.CLAWORKS_PRODUCT).toBe("1");
    expect(env.OPENCLAW_CONFIG_PATH).toContain("claworks.json");
    expect(env.OPENCLAW_GATEWAY_PORT).toBe(String(CLAWORKS_DEFAULT_GATEWAY_PORT));
  });

  it("does not infer product mode for OpenClaw state", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_STATE_DIR: "/tmp/test-openclaw/.openclaw",
    };
    detectAndApplyClaworksCli(env);
    expect(env.CLAWORKS_PRODUCT).toBeUndefined();
  });
});

describe("warnIfOpenClawEntryWithClaworksState", () => {
  it("warns once for openclaw entry with ClaWorks state", () => {
    const env: NodeJS.ProcessEnv = {
      _CLAWORKS_ARGV1: "/repo/openclaw.mjs",
      OPENCLAW_STATE_DIR: "/home/user/.claworks",
    };
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      warnIfOpenClawEntryWithClaworksState(env);
      warnIfOpenClawEntryWithClaworksState(env);
    } finally {
      process.stderr.write = original;
    }
    expect(lines.join("")).toContain("claworks.mjs");
    expect(env._CLAWORKS_MISENTRY_WARNED).toBe("1");
  });
});
