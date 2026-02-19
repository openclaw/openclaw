/**
 * Setup Wizard Tools — Unit Tests
 *
 * Tests cover:
 *   - Credential format validation (rejects bad tokens)
 *   - Real API calls with mocked fetch (returns bot info per channel)
 *   - Network failure graceful degradation
 *   - token_mismatch dry_run lists channels without modifying
 *   - config_drift restores missing cognitive files
 *   - Channel detection reads workspace/channels/
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import register from "../index.js";

// ── Types ──

type Tool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: any) => Promise<any>;
};

// ── State ──

let tmpWorkspace: string;
let tools: Tool[];
let toolMap: Map<string, Tool>;

function findTool(name: string): Tool {
  const tool = toolMap.get(name);
  if (!tool)
    throw new Error(`Tool not found: ${name}. Available: ${[...toolMap.keys()].join(", ")}`);
  return tool;
}

async function callTool(name: string, params: any) {
  const tool = findTool(name);
  return tool.execute("test-run", params);
}

function extractText(result: any): string {
  if (!result?.content) return JSON.stringify(result);
  return result.content.map((c: any) => c.text || "").join("\n");
}

// ── Helpers for workspace scaffolding ──

async function writeJson(p: string, data: any) {
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2), "utf-8");
}

async function createChannel(ws: string, id: string, type: string, credentials: any) {
  const channelConfig = {
    id,
    type,
    name: `${type} test channel`,
    credentials,
    created_at: new Date().toISOString(),
    status: "active",
  };
  await mkdir(join(ws, "channels"), { recursive: true });
  await writeFile(
    join(ws, "channels", `${id}.json`),
    JSON.stringify(channelConfig, null, 2),
    "utf-8",
  );
}

async function createAgent(ws: string, bizId: string, agentId: string, files: string[] = []) {
  const agentDir = join(ws, "businesses", bizId, "agents", agentId);
  await mkdir(agentDir, { recursive: true });
  for (const f of files) {
    await writeFile(join(agentDir, f), `# ${f}\n`, "utf-8");
  }
  // Write business manifest
  const manifestPath = join(ws, "businesses", bizId, "manifest.json");
  if (!existsSync(manifestPath)) {
    await writeFile(manifestPath, JSON.stringify({ id: bizId, name: bizId }), "utf-8");
  }
}

// ── Lifecycle ──

beforeAll(async () => {
  tmpWorkspace = await mkdtemp(join(tmpdir(), "mabos-setup-wizard-"));
  tools = [];
  toolMap = new Map();

  const api = {
    id: "mabos-setup-wizard-test",
    name: "Setup Wizard Test",
    version: "0.1.0",
    description: "Setup wizard test instance",
    source: "test",
    config: { agents: { defaults: { workspace: tmpWorkspace } } } as any,
    pluginConfig: {},
    runtime: {} as any,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string) => console.error(`  [error] ${msg}`),
    },
    registerTool: (tool: any) => {
      tools.push(tool);
      toolMap.set(tool.name, tool);
    },
    registerHook: () => {},
    registerHttpHandler: () => {},
    registerHttpRoute: () => {},
    registerChannel: () => {},
    registerGatewayMethod: () => {},
    registerCli: () => {},
    registerService: () => {},
    registerProvider: () => {},
    registerCommand: () => {},
    resolvePath: (p: string) => p,
    on: () => {},
  };

  register(api as any);
  console.log(`  Registered ${tools.length} tools, workspace: ${tmpWorkspace}`);
});

afterAll(async () => {
  await rm(tmpWorkspace, { recursive: true, force: true });
});

// ── Tests ──

describe("setup_wizard tools registration", () => {
  it("registers all 5 setup wizard tools", () => {
    const setupTools = [
      "setup_wizard_start",
      "setup_channel",
      "setup_health_check",
      "setup_auto_fix",
      "setup_status_dashboard",
    ];
    for (const name of setupTools) {
      assert.ok(toolMap.has(name), `Missing tool: ${name}`);
    }
  });
});

describe("setup_channel — format validation", () => {
  it("rejects invalid Telegram bot token format", async () => {
    // Mock fetch to ensure it's never called for format failures
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("fetch should not be called for format validation");
    };
    try {
      const result = await callTool("setup_channel", {
        channel_type: "telegram",
        credentials: { telegram: { bot_token: "not-a-valid-token" } },
        test_connection: true,
      });
      const text = extractText(result);
      assert.ok(
        text.includes("❌") || text.includes("Invalid"),
        `Expected rejection, got: ${text}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects Discord missing application_id", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("fetch should not be called for format validation");
    };
    try {
      const result = await callTool("setup_channel", {
        channel_type: "discord",
        credentials: { discord: { bot_token: "abc123" } },
        test_connection: true,
      });
      const text = extractText(result);
      assert.ok(
        text.includes("❌") || text.includes("required"),
        `Expected rejection, got: ${text}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects invalid Slack bot token format", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("fetch should not be called for format validation");
    };
    try {
      const result = await callTool("setup_channel", {
        channel_type: "slack",
        credentials: { slack: { bot_token: "not-xoxb-token" } },
        test_connection: true,
      });
      const text = extractText(result);
      assert.ok(
        text.includes("❌") || text.includes("xoxb"),
        `Expected Slack token rejection, got: ${text}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("setup_channel — mocked API calls", () => {
  it("Telegram: returns bot info on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        ok: true,
        result: { id: 123456, first_name: "TestBot", username: "test_bot" },
      }),
    }) as any;

    try {
      const result = await callTool("setup_channel", {
        channel_type: "telegram",
        credentials: { telegram: { bot_token: "123456:ABCdefGHIjklMNOpqrsTUVwxyz" } },
        test_connection: true,
      });
      const text = extractText(result);
      assert.ok(text.includes("✅") || text.includes("Success"), `Expected success, got: ${text}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Discord: returns bot info on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ id: "987654321", name: "TestBot" }),
    }) as any;

    try {
      const result = await callTool("setup_channel", {
        channel_type: "discord",
        credentials: {
          discord: { bot_token: "MTIzNDU2.abcdef.ghijkl", application_id: "987654321" },
        },
        test_connection: true,
      });
      const text = extractText(result);
      assert.ok(text.includes("✅") || text.includes("Success"), `Expected success, got: ${text}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Slack: returns team info on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true, team: "TestTeam", user: "bot_user" }),
    }) as any;

    try {
      const result = await callTool("setup_channel", {
        channel_type: "slack",
        credentials: { slack: { bot_token: "xoxb-1234-5678-abcdefgh" } },
        test_connection: true,
      });
      const text = extractText(result);
      assert.ok(text.includes("✅") || text.includes("Success"), `Expected success, got: ${text}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("setup_channel — network failure graceful degradation", () => {
  it("succeeds with warning when network is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;

    try {
      const result = await callTool("setup_channel", {
        channel_type: "telegram",
        credentials: { telegram: { bot_token: "123456:ABCdefGHIjklMNOpqrsTUVwxyz" } },
        test_connection: true,
      });
      const text = extractText(result);
      // Should NOT be a hard failure — should still write config
      assert.ok(
        !text.includes("Channel setup failed"),
        `Expected graceful degradation, got: ${text}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("setup_auto_fix — token_mismatch", () => {
  it("dry_run lists channels without modifying config files", async () => {
    // Setup: create a channel config
    await createChannel(tmpWorkspace, "tg_dry_run", "telegram", {
      bot_token: "111222:AABBccDDeeFFggHHiiJJkkLL",
    });

    const result = await callTool("setup_auto_fix", {
      issue_type: "token_mismatch",
      dry_run: true,
    });
    const text = extractText(result);
    assert.ok(text.includes("Dry Run"), "Should be in dry run mode");
    assert.ok(text.includes("Would validate"), "Should describe validation intent");

    // Verify the config was NOT modified
    const configRaw = await readFile(join(tmpWorkspace, "channels", "tg_dry_run.json"), "utf-8");
    const config = JSON.parse(configRaw);
    assert.equal(config.status, "active", "Status should remain unchanged in dry run");
  });
});

describe("setup_auto_fix — config_drift", () => {
  it("restores missing cognitive files", async () => {
    // Create an agent with only some cognitive files
    await createAgent(tmpWorkspace, "drift-biz", "drift-agent", ["Beliefs.md", "Desires.md"]);

    const result = await callTool("setup_auto_fix", {
      issue_type: "config_drift",
      dry_run: false,
    });
    const text = extractText(result);
    assert.ok(
      text.includes("Restored stub") || text.includes("drift issue"),
      `Expected drift fix, got: ${text}`,
    );

    // Verify missing cognitive files were restored
    const agentDir = join(tmpWorkspace, "businesses", "drift-biz", "agents", "drift-agent");
    for (const cf of ["Goals.md", "Plans.md", "Intentions.md"]) {
      assert.ok(existsSync(join(agentDir, cf)), `Missing restored file: ${cf}`);
      const content = await readFile(join(agentDir, cf), "utf-8");
      assert.ok(content.includes("Auto-restored"), `${cf} should contain restoration notice`);
    }

    // Verify backup was created
    const backupsDir = join(tmpWorkspace, ".config-backups");
    assert.ok(existsSync(backupsDir), "Backups directory should be created");
  });

  it("dry_run reports drift without modifying files", async () => {
    // Create an agent missing some files
    await createAgent(tmpWorkspace, "drift-biz2", "drift-agent2", ["Beliefs.md"]);

    const result = await callTool("setup_auto_fix", {
      issue_type: "config_drift",
      dry_run: true,
    });
    const text = extractText(result);
    assert.ok(text.includes("Dry Run"), "Should be dry run");
    assert.ok(text.includes("drift issue"), "Should report drift issues");

    // Verify files were NOT created
    const agentDir = join(tmpWorkspace, "businesses", "drift-biz2", "agents", "drift-agent2");
    assert.ok(!existsSync(join(agentDir, "Goals.md")), "Goals.md should NOT exist in dry run");
  });
});

describe("setup_wizard_start — channel detection", () => {
  it("detects channels from workspace/channels/ directory", async () => {
    // Create channels
    await createChannel(tmpWorkspace, "detect_tg", "telegram", {
      bot_token: "999888:AaBbCcDdEeFf",
    });
    await createChannel(tmpWorkspace, "detect_dc", "discord", {
      bot_token: "MTk.xyz",
      application_id: "1234",
    });

    // Mock fetch so testChannelConnection doesn't make real calls
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;

    try {
      const result = await callTool("setup_wizard_start", {});
      const text = extractText(result);
      // The wizard should report channels > 0
      assert.ok(
        text.includes("Channels:") && !text.includes("Channels: 0"),
        `Should detect channels, got: ${text}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("httpRequest — shared utility", () => {
  it("is exported from common.ts", async () => {
    // Verify the import works by checking it was used in testChannelConnection
    // We already tested it indirectly via the mocked fetch tests above
    // This test just ensures the module exports it
    const common = await import("../src/tools/common.js");
    assert.ok(typeof common.httpRequest === "function", "httpRequest should be exported");
  });
});
