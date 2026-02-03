import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_RULES,
  normalizePath,
  patternToRegex,
  pathMatchesPatterns,
  extractPaths,
} from "./index.js";

const HOME = os.homedir();

describe("security-audit", () => {
  describe("normalizePath", () => {
    it("expands ~ to home directory", () => {
      expect(normalizePath("~/.ssh/id_rsa")).toBe(`${HOME}/.ssh/id_rsa`);
      expect(normalizePath("~/Documents")).toBe(`${HOME}/Documents`);
    });

    it("preserves absolute paths", () => {
      expect(normalizePath("/etc/passwd")).toBe("/etc/passwd");
    });

    it("resolves relative paths", () => {
      const result = normalizePath("./test.txt");
      expect(result).toContain("test.txt");
      expect(result.startsWith("/")).toBe(true);
    });
  });

  describe("patternToRegex", () => {
    it("converts simple patterns", () => {
      const regex = patternToRegex("~/.ssh/id_rsa");
      expect(regex.test(`${HOME}/.ssh/id_rsa`)).toBe(true);
      expect(regex.test(`${HOME}/.ssh/id_ed25519`)).toBe(false);
    });

    it("handles * wildcard (single segment)", () => {
      const regex = patternToRegex("~/.ssh/id_*");
      expect(regex.test(`${HOME}/.ssh/id_rsa`)).toBe(true);
      expect(regex.test(`${HOME}/.ssh/id_ed25519`)).toBe(true);
      expect(regex.test(`${HOME}/.ssh/id_rsa/nested`)).toBe(false);
    });

    it("handles ** wildcard (multiple segments)", () => {
      const regex = patternToRegex("~/.config/**");
      expect(regex.test(`${HOME}/.config/app`)).toBe(true);
      expect(regex.test(`${HOME}/.config/app/settings.json`)).toBe(true);
    });

    it("escapes special regex characters", () => {
      const regex = patternToRegex("~/.config/[test].json");
      expect(regex.test(`${HOME}/.config/[test].json`)).toBe(true);
      expect(regex.test(`${HOME}/.config/test.json`)).toBe(false);
    });
  });

  describe("pathMatchesPatterns", () => {
    it("matches SSH key patterns", () => {
      const patterns = ["~/.ssh/id_*", "~/.ssh/*_key"];
      expect(pathMatchesPatterns("~/.ssh/id_rsa", patterns)).toBe(true);
      expect(pathMatchesPatterns("~/.ssh/id_ed25519", patterns)).toBe(true);
      expect(pathMatchesPatterns("~/.ssh/github_key", patterns)).toBe(true);
      expect(pathMatchesPatterns("~/.ssh/known_hosts", patterns)).toBe(false);
    });

    it("matches env file patterns", () => {
      const patterns = ["**/.env", "**/.env.*"];
      expect(pathMatchesPatterns("/app/.env", patterns)).toBe(true);
      expect(pathMatchesPatterns("/home/user/project/.env.local", patterns)).toBe(true);
    });

    it("handles absolute paths", () => {
      const patterns = ["~/.aws/credentials"];
      expect(pathMatchesPatterns(`${HOME}/.aws/credentials`, patterns)).toBe(true);
    });
  });

  describe("extractPaths", () => {
    it("extracts path from read tool", () => {
      expect(extractPaths("read", { file_path: "/etc/passwd" })).toEqual(["/etc/passwd"]);
      expect(extractPaths("read", { path: "/etc/passwd" })).toEqual(["/etc/passwd"]);
    });

    it("extracts path from write tool", () => {
      expect(extractPaths("write", { file_path: "~/.bashrc" })).toEqual(["~/.bashrc"]);
    });

    it("extracts path from edit tool", () => {
      expect(extractPaths("edit", { file_path: "~/.ssh/config" })).toEqual(["~/.ssh/config"]);
    });

    it("extracts paths from exec command", () => {
      const paths = extractPaths("exec", { command: "cat ~/.ssh/id_rsa" });
      expect(paths).toContain("~/.ssh/id_rsa");
    });

    it("extracts multiple paths from exec command", () => {
      const paths = extractPaths("exec", { command: "cp ~/.env /tmp/backup" });
      expect(paths).toContain("~/.env");
      expect(paths).toContain("/tmp/backup");
    });

    it("returns empty array for unknown tools", () => {
      expect(extractPaths("UnknownTool", { file: "test.txt" })).toEqual([]);
    });

    it("returns empty array for missing params", () => {
      expect(extractPaths("read", null)).toEqual([]);
      expect(extractPaths("read", {})).toEqual([]);
    });
  });

  describe("built-in rules", () => {
    describe("ssh-keys", () => {
      const rule = BUILT_IN_RULES.find((r) => r.id === "ssh-keys")!;

      it("has correct patterns", () => {
        expect(rule.patterns).toContain("~/.ssh/id_*");
        expect(rule.patterns).toContain("~/.ssh/*_key");
        expect(rule.patterns).toContain("~/.ssh/config");
      });

      it("blocks read and write operations", () => {
        expect(rule.operations).toContain("read");
        expect(rule.operations).toContain("write");
      });
    });

    describe("aws-credentials", () => {
      const rule = BUILT_IN_RULES.find((r) => r.id === "aws-credentials")!;

      it("has correct patterns", () => {
        expect(rule.patterns).toContain("~/.aws/credentials");
        expect(rule.patterns).toContain("~/.aws/config");
      });
    });

    describe("shell-config", () => {
      const rule = BUILT_IN_RULES.find((r) => r.id === "shell-config")!;

      it("only blocks write operations", () => {
        expect(rule.operations).toContain("write");
        expect(rule.operations).not.toContain("read");
      });

      it("covers common shell configs", () => {
        expect(rule.patterns).toContain("~/.bashrc");
        expect(rule.patterns).toContain("~/.zshrc");
        expect(rule.patterns).toContain("~/.profile");
      });
    });

    describe("env-files", () => {
      const rule = BUILT_IN_RULES.find((r) => r.id === "env-files")!;

      it("only blocks read operations", () => {
        expect(rule.operations).toContain("read");
        expect(rule.operations).not.toContain("write");
      });

      it("matches .env variations", () => {
        expect(rule.patterns).toContain("**/.env");
        expect(rule.patterns).toContain("**/.env.local");
        expect(rule.patterns).toContain("**/.env.production");
      });
    });
  });

  describe("rule coverage", () => {
    it("has all expected rule IDs", () => {
      const ruleIds = BUILT_IN_RULES.map((r) => r.id);
      expect(ruleIds).toContain("ssh-keys");
      expect(ruleIds).toContain("gpg-keys");
      expect(ruleIds).toContain("aws-credentials");
      expect(ruleIds).toContain("npm-credentials");
      expect(ruleIds).toContain("shell-config");
      expect(ruleIds).toContain("env-files");
      expect(ruleIds).toContain("kube-config");
      expect(ruleIds).toContain("docker-config");
    });

    it("all rules have required fields", () => {
      for (const rule of BUILT_IN_RULES) {
        expect(rule.id).toBeDefined();
        expect(rule.description).toBeDefined();
        expect(Array.isArray(rule.patterns)).toBe(true);
        expect(rule.patterns.length).toBeGreaterThan(0);
        expect(Array.isArray(rule.operations)).toBe(true);
        expect(rule.operations.length).toBeGreaterThan(0);
      }
    });
  });
});
