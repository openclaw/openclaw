/**
 * Reproduction test for issue #92684.
 *
 * Prints scanner results for each scenario to stdout so the output
 * can be included in the PR body as real behavior proof.
 * Run: pnpm vitest run scripts/repro-92684.test.ts --reporter=verbose
 */
import { describe, expect, it } from "vitest";
import { scanEmptyAllowlistPolicyWarnings } from "../src/commands/doctor/shared/empty-allowlist-scan.js";

describe("repro #92684: doctor false-positive parent groupAllowFrom warning", () => {
  it("Test 1: all accounts override with groupAllowFrom — no false warning", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "open",
            groupPolicy: "allowlist",
            accounts: {
              work: { groupPolicy: "allowlist", groupAllowFrom: ["+1234567890"] },
              personal: { groupPolicy: "allowlist", groupAllowFrom: ["+1987654321"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    console.log("Warnings:", JSON.stringify(warnings));
    expect(warnings).toStrictEqual([]);
  });

  it("Test 2: some accounts lack groupAllowFrom — parent warning preserved", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            groupPolicy: "allowlist",
            accounts: {
              work: { groupPolicy: "allowlist", groupAllowFrom: ["+1234567890"] },
              personal: { groupPolicy: "allowlist" },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    console.log("Warnings:", JSON.stringify(warnings));
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("Test 3: DM policy warnings preserved at parent scope", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "allowlist",
            groupPolicy: "allowlist",
            accounts: {
              work: { groupPolicy: "allowlist", groupAllowFrom: ["+1234567890"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    console.log("Warnings:", JSON.stringify(warnings));
    expect(warnings.some((w) => w.includes("dmPolicy"))).toBe(true);
  });

  it("Test 4: accounts with allowFrom on fallback channel — no false warning", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "open",
            groupPolicy: "allowlist",
            accounts: {
              work: { groupPolicy: "allowlist", allowFrom: ["+1234567890"] },
              personal: { groupPolicy: "allowlist", allowFrom: ["+1987654321"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    console.log("Warnings:", JSON.stringify(warnings));
    expect(warnings).toStrictEqual([]);
  });

  it("Test 5: disabled account without allowlist does not trigger parent warning", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "open",
            groupPolicy: "allowlist",
            accounts: {
              work: { groupPolicy: "allowlist", groupAllowFrom: ["+1234567890"] },
              personal: { enabled: false, groupPolicy: "allowlist" },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    console.log("Warnings:", JSON.stringify(warnings));
    expect(warnings).toStrictEqual([]);
  });
});
