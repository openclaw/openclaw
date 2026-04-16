import { describe, expect, it } from "vitest";
import { checkMutationGate } from "./mutation-gate.js";

describe("checkMutationGate", () => {
  describe("normal mode", () => {
    it("allows all tools in normal mode", () => {
      expect(checkMutationGate("exec", "normal").blocked).toBe(false);
      expect(checkMutationGate("write", "normal").blocked).toBe(false);
      expect(checkMutationGate("edit", "normal").blocked).toBe(false);
      expect(checkMutationGate("apply_patch", "normal").blocked).toBe(false);
    });
  });

  describe("plan mode — blocked tools", () => {
    const blockedTools = [
      "apply_patch", "edit", "exec", "gateway", "message",
      "nodes", "process", "sessions_send", "sessions_spawn",
      "subagents", "write",
    ];

    for (const tool of blockedTools) {
      it(`blocks ${tool}`, () => {
        const result = checkMutationGate(tool, "plan");
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("blocked in plan mode");
      });
    }

    it("blocks case-insensitively", () => {
      expect(checkMutationGate("EXEC", "plan").blocked).toBe(true);
      expect(checkMutationGate("Write", "plan").blocked).toBe(true);
    });
  });

  describe("plan mode — allowed tools", () => {
    const allowedTools = [
      "read", "web_search", "web_fetch", "memory_search",
      "memory_get", "update_plan", "exit_plan_mode", "session_status",
    ];

    for (const tool of allowedTools) {
      it(`allows ${tool}`, () => {
        expect(checkMutationGate(tool, "plan").blocked).toBe(false);
      });
    }
  });

  describe("plan mode — suffix patterns", () => {
    it("blocks tools ending with .write", () => {
      expect(checkMutationGate("custom_mcp.write", "plan").blocked).toBe(true);
    });

    it("blocks tools ending with .edit", () => {
      expect(checkMutationGate("files.edit", "plan").blocked).toBe(true);
    });

    it("blocks tools ending with .delete", () => {
      expect(checkMutationGate("records.delete", "plan").blocked).toBe(true);
    });

    it("allows tools with non-mutation suffixes", () => {
      expect(checkMutationGate("custom_mcp.read", "plan").blocked).toBe(false);
      expect(checkMutationGate("data.search", "plan").blocked).toBe(false);
    });
  });

  describe("plan mode — exec read-only whitelist", () => {
    const readOnlyCommands = [
      "ls -la", "cat README.md", "pwd", "git status", "git log --oneline",
      "git diff HEAD", "git show abc123", "which node", "find . -name '*.ts'",
      "grep -rn 'TODO'", "rg pattern", "head -20 file.ts", "tail -5 log",
      "wc -l src/*.ts", "file image.png", "stat package.json", "du -sh .",
      "df -h",
    ];

    for (const cmd of readOnlyCommands) {
      it(`allows exec with read-only command: ${cmd.substring(0, 30)}`, () => {
        expect(checkMutationGate("exec", "plan", cmd).blocked).toBe(false);
      });
    }

    const mutatingCommands = [
      "rm -rf node_modules", "git commit -m 'test'", "git push origin main",
      "npm install", "docker run hello-world", "mkdir -p new-dir",
    ];

    for (const cmd of mutatingCommands) {
      it(`blocks exec with mutating command: ${cmd.substring(0, 30)}`, () => {
        expect(checkMutationGate("exec", "plan", cmd).blocked).toBe(true);
      });
    }

    it("blocks exec without a command argument", () => {
      expect(checkMutationGate("exec", "plan").blocked).toBe(true);
      expect(checkMutationGate("exec", "plan", "").blocked).toBe(true);
    });

    it("blocks commands with newline separators", () => {
      expect(checkMutationGate("exec", "plan", "ls\nrm -rf tmp").blocked).toBe(true);
      expect(checkMutationGate("exec", "plan", "cat file\r\necho > pwned").blocked).toBe(true);
    });

    it("blocks dangerous flags on otherwise-allowed commands", () => {
      expect(checkMutationGate("exec", "plan", "find . -delete").blocked).toBe(true);
      expect(checkMutationGate("exec", "plan", "find . -exec rm {} ;").blocked).toBe(true);
    });

    it("blocks bash alias the same way as exec", () => {
      expect(checkMutationGate("bash", "plan", "rm -rf /").blocked).toBe(true);
      expect(checkMutationGate("bash", "plan", "ls -la").blocked).toBe(false);
    });
  });

  describe("plan mode — bash tool blocked without command", () => {
    it("blocks bash in plan mode when no command is given", () => {
      const result = checkMutationGate("bash", "plan");
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("blocked in plan mode");
    });
  });

  describe("plan mode — shell compound operators blocked", () => {
    it("blocks redirect operator: echo hi > file", () => {
      expect(checkMutationGate("exec", "plan", "echo hi > file").blocked).toBe(true);
    });

    it("blocks pipe operator: cat file | grep x", () => {
      expect(checkMutationGate("exec", "plan", "cat file | grep x").blocked).toBe(true);
    });

    it("blocks semicolon chaining: ls; rm -rf /", () => {
      expect(checkMutationGate("exec", "plan", "ls; rm -rf /").blocked).toBe(true);
    });
  });

  describe("plan mode — newlines in commands blocked", () => {
    it("blocks newline-separated commands: ls\\nrm -rf tmp", () => {
      expect(checkMutationGate("exec", "plan", "ls\nrm -rf tmp").blocked).toBe(true);
    });
  });

  describe("plan mode — dangerous flags blocked", () => {
    it("blocks find . -delete", () => {
      expect(checkMutationGate("exec", "plan", "find . -delete").blocked).toBe(true);
    });

    it("blocks find . -exec rm {} ;", () => {
      expect(checkMutationGate("exec", "plan", "find . -exec rm {} ;").blocked).toBe(true);
    });
  });
});
