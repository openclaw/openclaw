import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  resolveRealtimeContextPackInstructions,
  waitForRealtimeContextPackRefreshesForTest,
} from "./realtime-context-pack.js";

let tempDir: string;
let previousStateDir: string | undefined;

function makeConfig(workspace: string, overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace,
        realtimeContext: {
          enabled: true,
          profileFiles: ["IDENTITY.md", "USER.md", "SOUL.md"],
          sourceFiles: ["state/registry/CONTEXT.md"],
          refreshEveryMinutes: 120,
          staleAfterMinutes: 360,
          maxChars: 24_000,
          ...overrides,
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

beforeEach(async () => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-realtime-context-pack-"));
  process.env.OPENCLAW_STATE_DIR = path.join(tempDir, "state");
});

afterEach(async () => {
  await waitForRealtimeContextPackRefreshesForTest();
  closeOpenClawAgentDatabasesForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("resolveRealtimeContextPackInstructions", () => {
  it("combines the bounded profile with configured workspace snapshots", async () => {
    const workspace = path.join(tempDir, "workspace");
    await fs.mkdir(path.join(workspace, "state/registry"), { recursive: true });
    await fs.writeFile(path.join(workspace, "IDENTITY.md"), "Name: Ron\n", "utf8");
    await fs.writeFile(path.join(workspace, "USER.md"), "User: Clifton\n", "utf8");
    await fs.writeFile(path.join(workspace, "SOUL.md"), "Concise and direct.\n", "utf8");
    await fs.writeFile(
      path.join(workspace, "state/registry/CONTEXT.md"),
      "Active theme: physical AI capex.\n",
      "utf8",
    );

    const instructions = await resolveRealtimeContextPackInstructions({
      agentId: "main",
      config: makeConfig(workspace),
      sessionKey: "agent:main:main",
    });

    expect(instructions).toContain("### IDENTITY.md");
    expect(instructions).toContain("Name: Ron");
    expect(instructions).toContain("OpenClaw cached working context");
    expect(instructions).toContain("### state/registry/CONTEXT.md");
    expect(instructions).toContain("Active theme: physical AI capex.");
    expect(instructions).not.toContain(workspace);
    expect(instructions?.length).toBeLessThanOrEqual(24_000);
  });

  it("returns the cached pack immediately and refreshes it in the background", async () => {
    const workspace = path.join(tempDir, "workspace");
    const contextPath = path.join(workspace, "state/registry/CONTEXT.md");
    await fs.mkdir(path.dirname(contextPath), { recursive: true });
    await fs.writeFile(path.join(workspace, "IDENTITY.md"), "Name: Ron\n", "utf8");
    await fs.writeFile(contextPath, "First snapshot.\n", "utf8");
    const config = makeConfig(workspace, { refreshEveryMinutes: 1, staleAfterMinutes: 2 });

    const first = await resolveRealtimeContextPackInstructions({
      agentId: "main",
      config,
      now: 1_000,
    });
    expect(first).toContain("First snapshot.");

    await fs.writeFile(contextPath, "Second snapshot.\n", "utf8");
    const staleRead = await resolveRealtimeContextPackInstructions({
      agentId: "main",
      config,
      now: Date.now() + 61_000,
    });
    expect(staleRead).toContain("First snapshot.");

    await waitForRealtimeContextPackRefreshesForTest();
    const refreshed = await resolveRealtimeContextPackInstructions({
      agentId: "main",
      config,
    });
    expect(refreshed).toContain("Second snapshot.");
  });

  it("rejects traversal and symlink escapes from configured sources", async () => {
    const workspace = path.join(tempDir, "workspace");
    const outside = path.join(tempDir, "private.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "IDENTITY.md"), "Name: Ron\n", "utf8");
    await fs.writeFile(outside, "Do not expose me.\n", "utf8");
    await fs.symlink(outside, path.join(workspace, "escape.md"));
    const warnings: string[] = [];

    const instructions = await resolveRealtimeContextPackInstructions({
      agentId: "main",
      config: makeConfig(workspace, { sourceFiles: ["../private.md", "escape.md"] }),
      warn: (message) => warnings.push(message),
    });

    expect(instructions).toContain("Name: Ron");
    expect(instructions).not.toContain("Do not expose me");
    expect(warnings.some((message) => message.includes("outside workspace"))).toBe(true);
  });

  it("is disabled unless explicitly enabled", async () => {
    const workspace = path.join(tempDir, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const config = makeConfig(workspace, { enabled: false });

    await expect(
      resolveRealtimeContextPackInstructions({ agentId: "main", config }),
    ).resolves.toBeUndefined();
  });

  it("uses default-agent context config when no explicit agent list exists", async () => {
    const workspace = path.join(tempDir, "workspace-default-only");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "IDENTITY.md"), "Name: Default Ron\n", "utf8");
    const config = makeConfig(workspace, { sourceFiles: [] });
    delete config.agents?.list;

    await expect(
      resolveRealtimeContextPackInstructions({ agentId: "main", config }),
    ).resolves.toContain("Name: Default Ron");
  });
});
