import { describe, expect, it } from "vitest";
import type { SkillEntry } from "./skills.js";
import {
  scanSkillSecurity,
  formatSecurityScanResult,
  type SecurityScanResult,
} from "./skills-security-scanner.js";

describe("skills-security-scanner", () => {
  describe("scanSkillSecurity", () => {
    it("should detect exec tool as high risk", async () => {
      const entry: SkillEntry = {
        skill: { name: "test-skill", description: "Test" },
        filePath: "/tmp/test/SKILL.md",
        metadata: {
          tools: ["Exec"],
        },
      };

      const result = await scanSkillSecurity(entry, "moderate");

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some((i) => i.type === "permission" && i.severity === "high")).toBe(
        true,
      );
      expect(result.riskLevel).toBe("high");
    });

    it("should pass low-risk skills in strict mode", async () => {
      const entry: SkillEntry = {
        skill: { name: "safe-skill", description: "Safe skill" },
        filePath: "/tmp/safe/SKILL.md",
        metadata: {
          tools: ["Read"], // Only read access
        },
      };

      const result = await scanSkillSecurity(entry, "strict");

      expect(result.passed).toBe(true);
      expect(result.riskLevel).toBe("low");
    });

    it("should block high-risk skills in strict mode", async () => {
      const entry: SkillEntry = {
        skill: { name: "dangerous-skill", description: "Dangerous" },
        filePath: "/tmp/dangerous/SKILL.md",
        metadata: {
          tools: ["Exec", "Write"],
        },
      };

      const result = await scanSkillSecurity(entry, "strict");

      expect(result.passed).toBe(false);
      expect(result.riskLevel).toBe("high");
    });

    it("should allow high-risk skills in permissive mode", async () => {
      const entry: SkillEntry = {
        skill: { name: "risky-skill", description: "Risky" },
        filePath: "/tmp/risky/SKILL.md",
        metadata: {
          tools: ["Exec", "Bash"],
        },
      };

      const result = await scanSkillSecurity(entry, "permissive");

      expect(result.passed).toBe(true);
      expect(result.riskLevel).toBe("high");
    });

    it("should calculate correct risk scores", async () => {
      const lowRiskEntry: SkillEntry = {
        skill: { name: "low", description: "Low risk" },
        filePath: "/tmp/low/SKILL.md",
        metadata: {
          tools: ["WebFetch"], // Low risk
        },
      };

      const highRiskEntry: SkillEntry = {
        skill: { name: "high", description: "High risk" },
        filePath: "/tmp/high/SKILL.md",
        metadata: {
          tools: ["Exec", "Write", "Bash"], // Multiple high risk
        },
      };

      const lowResult = await scanSkillSecurity(lowRiskEntry, "moderate");
      const highResult = await scanSkillSecurity(highRiskEntry, "moderate");

      expect(lowResult.score).toBeLessThan(highResult.score);
      expect(lowResult.riskLevel).toBe("low");
      expect(highResult.riskLevel).toBe("high");
    });
  });

  describe("formatSecurityScanResult", () => {
    it("should format result with no issues", () => {
      const result: SecurityScanResult = {
        riskLevel: "low",
        issues: [],
        score: 0,
        passed: true,
      };

      const formatted = formatSecurityScanResult(result);

      expect(formatted).toContain("🟢");
      expect(formatted).toContain("Risk Level: LOW");
      expect(formatted).toContain("No security issues");
    });

    it("should format result with issues grouped by severity", () => {
      const result: SecurityScanResult = {
        riskLevel: "high",
        issues: [
          {
            type: "permission",
            severity: "high",
            message: "Exec access",
          },
          {
            type: "code_pattern",
            severity: "medium",
            message: "Base64 decoding",
          },
        ],
        score: 70,
        passed: false,
      };

      const formatted = formatSecurityScanResult(result);

      expect(formatted).toContain("🔴");
      expect(formatted).toContain("Risk Level: HIGH");
      expect(formatted).toContain("🔴 HIGH:");
      expect(formatted).toContain("Exec access");
      expect(formatted).toContain("🟡 MEDIUM:");
      expect(formatted).toContain("Base64 decoding");
    });
  });
});
