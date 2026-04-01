/**
 * ACL Message Delivery — Integration test
 *
 * Verifies the complete message delivery pipeline between C-Suite agents
 * when implementing a business goal:
 *
 * 1. CEO sends REQUEST to CFO via agent_message
 * 2. Access control permits the message
 * 3. Message arrives in CFO's inbox
 * 4. Cognitive router scans inbox, detects signals
 * 5. processInboxResponses composes a reply
 * 6. Reply arrives in CEO's inbox
 * 7. CEO reads the reply via inbox_read
 */

import { randomUUID } from "node:crypto";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  enhancedHeartbeatCycle,
  computeCognitiveDemand,
  selectDepth,
  applyDepthOverrides,
} from "../src/tools/cognitive-router.js";
import { scanInbox } from "../src/tools/cognitive-signal-scanners.js";
import { checkAgentToAgentPolicy } from "../src/tools/common.js";
import { createCommunicationTools } from "../src/tools/communication-tools.js";

// ── Helpers ──────────────────────────────────────────────────

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

async function writeJson(p: string, d: any) {
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

// ── Workspace Setup ──────────────────────────────────────────

let workspaceDir: string;

async function setupWorkspace() {
  workspaceDir = join(tmpdir(), `mabos-test-${randomUUID()}`);
  const agentsDir = join(workspaceDir, "agents");

  // Create C-Suite agent directories with minimal agent.json
  for (const agentId of ["ceo", "cfo", "cmo", "cto", "coo"]) {
    const agentDir = join(agentsDir, agentId);
    await mkdir(agentDir, { recursive: true });
    await writeJson(join(agentDir, "agent.json"), {
      id: agentId,
      name: `Chief ${agentId.slice(1).toUpperCase()} Officer`,
      bdi: {
        commitmentStrategy: "open-minded",
        cycleFrequency: { fullCycleMinutes: 120, quickCheckMinutes: 15 },
        reasoningMethods: ["heuristic"],
        cognitiveRouter: {
          enabled: true,
          thresholds: {
            reflexiveCeiling: 0.3,
            deliberativeFloor: 0.6,
            reflexiveConfidenceMin: 0.75,
            analyticalConfidenceMin: 0.7,
            maxConsecutiveReflexive: 4,
          },
        },
      },
    });
    // Empty inbox
    await writeJson(join(agentDir, "inbox.json"), []);
    // Minimal Goals.md
    await writeFile(
      join(agentDir, "Goals.md"),
      `# ${agentId.toUpperCase()} Goals\n\n### G-1: Maintain operational excellence\n**Status:** active\n**Priority:** 0.8\n**Progress:** 40\n**Deadline:** ongoing\n`,
      "utf-8",
    );
  }

  return workspaceDir;
}

async function teardownWorkspace() {
  if (workspaceDir) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

// ── Mock API ────────────────────────────────────────────────

function createMockApi(opts: {
  workspaceDir: string;
  agentToAgentEnabled?: boolean;
  agentToAgentAllow?: string[];
}) {
  const logs: string[] = [];
  const heartbeatRequests: any[] = [];

  return {
    api: {
      id: "mabos-test",
      name: "MABOS Test",
      version: "0.1.0",
      description: "Test",
      source: "test",
      config: {
        agents: { defaults: { workspace: opts.workspaceDir } },
        tools: {
          agentToAgent: {
            enabled: opts.agentToAgentEnabled ?? true,
            allow: opts.agentToAgentAllow ?? [],
          },
        },
      } as any,
      pluginConfig: {},
      runtime: {
        system: {
          requestHeartbeatNow: (params: any) => {
            heartbeatRequests.push(params);
          },
        },
        subagent: null, // No LLM in unit tests — tests the fallback path
      } as any,
      logger: {
        debug: (msg: string) => logs.push(`[debug] ${msg}`),
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
        error: (msg: string) => logs.push(`[error] ${msg}`),
      },
      registerTool: () => {},
      registerHook: () => {},
      registerHttpRoute: () => {},
      registerChannel: () => {},
      registerGatewayMethod: () => {},
      registerCli: () => {},
      registerService: () => {},
      registerProvider: () => {},
      registerCommand: () => {},
      registerContextEngine: () => {},
      resolvePath: (p: string) => p,
      on: () => {},
    } as any,
    logs,
    heartbeatRequests,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("ACL Message Delivery — C-Suite Business Goal", () => {
  beforeEach(async () => {
    await setupWorkspace();
  });

  afterEach(async () => {
    await teardownWorkspace();
  });

  // ── 1. Access Control ──────────────────────────────────

  describe("access control", () => {
    it("allows messaging when agentToAgent is enabled", () => {
      const { api } = createMockApi({ workspaceDir, agentToAgentEnabled: true });
      const result = checkAgentToAgentPolicy(api, "ceo", "cfo");
      expect(result).toBeNull();
    });

    it("blocks messaging when agentToAgent is disabled", () => {
      const { api } = createMockApi({ workspaceDir, agentToAgentEnabled: false });
      const result = checkAgentToAgentPolicy(api, "ceo", "cfo");
      expect(result).toContain("disabled");
    });

    it("allows same-agent messaging even when disabled", () => {
      const { api } = createMockApi({ workspaceDir, agentToAgentEnabled: false });
      const result = checkAgentToAgentPolicy(api, "ceo", "ceo");
      expect(result).toBeNull();
    });

    it("blocks when agent not in allowlist", () => {
      const { api } = createMockApi({
        workspaceDir,
        agentToAgentEnabled: true,
        agentToAgentAllow: ["ceo", "cfo"],
      });
      // cmo is not in the allowlist
      const result = checkAgentToAgentPolicy(api, "ceo", "cmo");
      expect(result).toContain("denied");
    });

    it("allows with wildcard allowlist", () => {
      const { api } = createMockApi({
        workspaceDir,
        agentToAgentEnabled: true,
        agentToAgentAllow: ["*"],
      });
      const result = checkAgentToAgentPolicy(api, "ceo", "cmo");
      expect(result).toBeNull();
    });

    it("allows with glob pattern c*o", () => {
      const { api } = createMockApi({
        workspaceDir,
        agentToAgentEnabled: true,
        agentToAgentAllow: ["c*o"],
      });
      // ceo matches c*o, cfo matches c*o
      const result = checkAgentToAgentPolicy(api, "ceo", "cfo");
      expect(result).toBeNull();
    });
  });

  // ── 2. Message Send & Receive ──────────────────────────

  describe("message delivery", () => {
    it("CEO sends REQUEST to CFO and message appears in CFO inbox", async () => {
      const { api } = createMockApi({ workspaceDir });
      const tools = createCommunicationTools(api);
      const agentMessage = tools.find((t) => t.name === "agent_message")!;

      const result = await agentMessage.execute("test-id", {
        from: "ceo",
        to: "cfo",
        performative: "REQUEST",
        content: "Review Q1 budget projections and provide variance analysis",
        priority: "high",
      });

      // Verify send succeeded
      expect(result.content[0].text).toContain("ceo → cfo");
      expect(result.content[0].text).toContain("REQUEST");

      // Verify message in CFO inbox
      const cfoInbox = await readJson(join(workspaceDir, "agents", "cfo", "inbox.json"));
      expect(cfoInbox).toHaveLength(1);
      expect(cfoInbox[0].from).toBe("ceo");
      expect(cfoInbox[0].to).toBe("cfo");
      expect(cfoInbox[0].performative).toBe("REQUEST");
      expect(cfoInbox[0].content).toContain("Q1 budget");
      expect(cfoInbox[0].read).toBe(false);
      expect(cfoInbox[0].priority).toBe("high");
    });

    it("blocks message when access control denies", async () => {
      const { api } = createMockApi({ workspaceDir, agentToAgentEnabled: false });
      const tools = createCommunicationTools(api);
      const agentMessage = tools.find((t) => t.name === "agent_message")!;

      const result = await agentMessage.execute("test-id", {
        from: "ceo",
        to: "cfo",
        performative: "REQUEST",
        content: "Should be blocked",
      });

      expect(result.content[0].text).toContain("ACL blocked");

      // CFO inbox should be empty
      const cfoInbox = await readJson(join(workspaceDir, "agents", "cfo", "inbox.json"));
      expect(cfoInbox).toHaveLength(0);
    });

    it("triggers requestHeartbeatNow for high-priority messages", async () => {
      const { api, heartbeatRequests } = createMockApi({ workspaceDir });
      const tools = createCommunicationTools(api);
      const agentMessage = tools.find((t) => t.name === "agent_message")!;

      await agentMessage.execute("test-id", {
        from: "ceo",
        to: "cfo",
        performative: "REQUEST",
        content: "Urgent budget review",
        priority: "urgent",
      });

      expect(heartbeatRequests).toHaveLength(1);
      expect(heartbeatRequests[0].reason).toContain("inbox-urgent");
      expect(heartbeatRequests[0].coalesceMs).toBe(100);
    });

    it("does NOT trigger heartbeat for normal-priority messages", async () => {
      const { api, heartbeatRequests } = createMockApi({ workspaceDir });
      const tools = createCommunicationTools(api);
      const agentMessage = tools.find((t) => t.name === "agent_message")!;

      await agentMessage.execute("test-id", {
        from: "ceo",
        to: "cfo",
        performative: "INFORM",
        content: "FYI: quarterly report ready",
        priority: "normal",
      });

      expect(heartbeatRequests).toHaveLength(0);
    });
  });

  // ── 3. Inbox Scanner ──────────────────────────────────

  describe("inbox signal scanning", () => {
    it("scanInbox detects unread messages from flat array format", async () => {
      const cfoDir = join(workspaceDir, "agents", "cfo");

      // Write a message in flat array format (as agent_message does)
      await writeJson(join(cfoDir, "inbox.json"), [
        {
          id: "MSG-001",
          from: "ceo",
          to: "cfo",
          performative: "REQUEST",
          content: "Review budget",
          priority: "high",
          timestamp: new Date().toISOString(),
          read: false,
        },
      ]);

      const signals = await scanInbox(cfoDir, "cfo", new Date(0).toISOString());

      expect(signals).toHaveLength(1);
      expect(signals[0].source).toBe("inbox");
      expect(signals[0].summary).toContain("REQUEST");
      expect(signals[0].summary).toContain("ceo");
      expect(signals[0].urgency).toBe(0.75); // "high" priority
      expect(signals[0].stakes).toBe(0.7); // REQUEST = high stakes
    });

    it("scanInbox treats INFORM as lower stakes", async () => {
      const cfoDir = join(workspaceDir, "agents", "cfo");

      await writeJson(join(cfoDir, "inbox.json"), [
        {
          id: "MSG-002",
          from: "cmo",
          to: "cfo",
          performative: "INFORM",
          content: "Marketing spend update",
          priority: "normal",
          timestamp: new Date().toISOString(),
          read: false,
        },
      ]);

      const signals = await scanInbox(cfoDir, "cfo", new Date(0).toISOString());

      expect(signals).toHaveLength(1);
      expect(signals[0].stakes).toBe(0.4); // INFORM = lower stakes
    });

    it("scanInbox skips already-read messages", async () => {
      const cfoDir = join(workspaceDir, "agents", "cfo");

      await writeJson(join(cfoDir, "inbox.json"), [
        {
          id: "MSG-003",
          from: "ceo",
          to: "cfo",
          performative: "REQUEST",
          content: "Old message",
          priority: "high",
          timestamp: new Date().toISOString(),
          read: true, // already read
        },
      ]);

      const signals = await scanInbox(cfoDir, "cfo", new Date(0).toISOString());

      expect(signals).toHaveLength(0);
    });
  });

  // ── 4. Full Round-Trip: CEO → CFO → CEO ────────────────

  describe("full round-trip message exchange", () => {
    it("CEO sends business goal, CFO processes and replies, CEO receives reply", async () => {
      const { api } = createMockApi({ workspaceDir });
      const tools = createCommunicationTools(api);
      const agentMessage = tools.find((t) => t.name === "agent_message")!;
      const inboxRead = tools.find((t) => t.name === "inbox_read")!;

      // === Step 1: CEO sends business goal to CFO ===
      await agentMessage.execute("step1", {
        from: "ceo",
        to: "cfo",
        performative: "REQUEST",
        content:
          "Implement cost reduction strategy: reduce operational expenses by 15% in Q2. " +
          "Analyze current spend, identify savings opportunities, and propose a phased plan.",
        priority: "high",
      });

      // Verify CFO received it
      const cfoInboxBefore = await readJson(join(workspaceDir, "agents", "cfo", "inbox.json"));
      expect(cfoInboxBefore).toHaveLength(1);
      expect(cfoInboxBefore[0].read).toBe(false);

      // === Step 2: Run heartbeat cycle — CFO processes inbox ===
      const log = {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      };
      await enhancedHeartbeatCycle(workspaceDir, api, log);

      // === Step 3: Verify CFO marked message as read ===
      const cfoInboxAfter = await readJson(join(workspaceDir, "agents", "cfo", "inbox.json"));
      expect(cfoInboxAfter[0].read).toBe(true);
      expect(cfoInboxAfter[0].read_at).toBeDefined();

      // === Step 4: Verify CEO received a reply ===
      const ceoInbox = await readJson(join(workspaceDir, "agents", "ceo", "inbox.json"));
      expect(ceoInbox.length).toBeGreaterThanOrEqual(1);

      const cfoReply = ceoInbox.find((m: any) => m.from === "cfo");
      expect(cfoReply).toBeDefined();
      expect(cfoReply.to).toBe("ceo");
      expect(cfoReply.performative).toBe("CONFIRM"); // Not AGREE
      expect(cfoReply.reply_to).toBe(cfoInboxBefore[0].id);
      expect(cfoReply.read).toBe(false);
      expect(cfoReply.content).toBeTruthy();
      expect(cfoReply.content.length).toBeGreaterThan(50); // Substantive response

      // === Step 5: CEO reads the reply ===
      const ceoReadResult = await inboxRead.execute("step5", {
        agent_id: "ceo",
        unread_only: true,
      });
      expect(ceoReadResult.content[0].text).toContain("cfo");
      expect(ceoReadResult.content[0].text).toContain("CONFIRM");
    });

    it("multi-agent chain: CEO → CFO → CTO collaboration", async () => {
      const { api } = createMockApi({ workspaceDir });
      const tools = createCommunicationTools(api);
      const agentMessage = tools.find((t) => t.name === "agent_message")!;

      // === Step 1: CEO sends to CFO ===
      await agentMessage.execute("s1", {
        from: "ceo",
        to: "cfo",
        performative: "REQUEST",
        content: "Evaluate ROI of cloud migration project. Coordinate with CTO on technical costs.",
        priority: "high",
      });

      // === Step 2: CEO sends to CTO ===
      await agentMessage.execute("s2", {
        from: "ceo",
        to: "cto",
        performative: "REQUEST",
        content: "Provide technical cost estimates for cloud migration. Share findings with CFO.",
        priority: "high",
      });

      // === Step 3: Run heartbeat — both agents process ===
      const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
      await enhancedHeartbeatCycle(workspaceDir, api, log);

      // === Step 4: Verify both responded to CEO ===
      const ceoInbox = await readJson(join(workspaceDir, "agents", "ceo", "inbox.json"));
      const cfoReply = ceoInbox.find((m: any) => m.from === "cfo");
      const ctoReply = ceoInbox.find((m: any) => m.from === "cto");

      expect(cfoReply).toBeDefined();
      expect(ctoReply).toBeDefined();
      expect(cfoReply.performative).toBe("CONFIRM");
      expect(ctoReply.performative).toBe("CONFIRM");

      // === Step 5: CFO sends to CTO (cross-agent coordination) ===
      await agentMessage.execute("s5", {
        from: "cfo",
        to: "cto",
        performative: "QUERY",
        content: "What are the estimated infrastructure costs for the cloud migration?",
        priority: "normal",
      });

      // Verify CTO received CFO's query
      const ctoInbox = await readJson(join(workspaceDir, "agents", "cto", "inbox.json"));
      const cfoQuery = ctoInbox.find((m: any) => m.from === "cfo" && m.performative === "QUERY");
      expect(cfoQuery).toBeDefined();
      expect(cfoQuery.content).toContain("infrastructure costs");

      // === Step 6: Run heartbeat again — CTO processes CFO's query ===
      await enhancedHeartbeatCycle(workspaceDir, api, log);

      // === Step 7: Verify CFO received CTO's INFORM reply ===
      const cfoInbox = await readJson(join(workspaceDir, "agents", "cfo", "inbox.json"));
      const ctoResponse = cfoInbox.find(
        (m: any) => m.from === "cto" && m.performative === "INFORM",
      );
      expect(ctoResponse).toBeDefined();
      expect(ctoResponse.reply_to).toBe(cfoQuery.id);
    });
  });

  // ── 5. Cognitive Router Depth Selection ────────────────

  describe("cognitive demand and depth", () => {
    it("REQUEST signal forces at least analytical depth", async () => {
      const cfoDir = join(workspaceDir, "agents", "cfo");

      // Write an urgent REQUEST
      await writeJson(join(cfoDir, "inbox.json"), [
        {
          id: "MSG-URGENT",
          from: "ceo",
          to: "cfo",
          performative: "REQUEST",
          content: "Urgent financial review",
          priority: "urgent",
          timestamp: new Date().toISOString(),
          read: false,
        },
      ]);

      const signals = await scanInbox(cfoDir, "cfo", new Date(0).toISOString());
      expect(signals.length).toBe(1);

      const thresholds = {
        reflexiveCeiling: 0.3,
        deliberativeFloor: 0.6,
        reflexiveConfidenceMin: 0.75,
        analyticalConfidenceMin: 0.7,
        maxConsecutiveReflexive: 4,
        fullCycleMinutes: 120,
        quickCheckMinutes: 15,
        commitmentStrategy: "open-minded" as const,
      };

      // Even if base demand is low, REQUEST should force analytical
      let depth = selectDepth(0.1, thresholds); // Would be reflexive
      depth = applyDepthOverrides(depth, signals, 0, thresholds);

      expect(depth).toBe("analytical"); // Forced up from reflexive
    });
  });

  // ── 6. Inbox Read Tool ─────────────────────────────────

  describe("inbox_read tool", () => {
    it("reads and filters unread messages by performative", async () => {
      const { api } = createMockApi({ workspaceDir });
      const tools = createCommunicationTools(api);
      const inboxRead = tools.find((t) => t.name === "inbox_read")!;

      // Populate CFO inbox with mixed messages
      await writeJson(join(workspaceDir, "agents", "cfo", "inbox.json"), [
        {
          id: "MSG-1",
          from: "ceo",
          to: "cfo",
          performative: "REQUEST",
          content: "Budget review",
          priority: "high",
          timestamp: new Date().toISOString(),
          read: false,
        },
        {
          id: "MSG-2",
          from: "cmo",
          to: "cfo",
          performative: "INFORM",
          content: "Marketing spend update",
          priority: "normal",
          timestamp: new Date().toISOString(),
          read: false,
        },
        {
          id: "MSG-3",
          from: "cto",
          to: "cfo",
          performative: "REQUEST",
          content: "Infra cost estimate",
          priority: "normal",
          timestamp: new Date().toISOString(),
          read: true, // already read
        },
      ]);

      // Read only unread REQUESTs
      const result = await inboxRead.execute("test", {
        agent_id: "cfo",
        unread_only: true,
        performative: "REQUEST",
      });

      const text = result.content[0].text;
      expect(text).toContain("MSG-1");
      expect(text).toContain("REQUEST");
      expect(text).not.toContain("MSG-2"); // INFORM filtered
      expect(text).not.toContain("MSG-3"); // Already read
    });
  });

  // ── 7. Mark Read Tool ──────────────────────────────────

  describe("inbox_mark_read tool", () => {
    it("marks specific messages as read", async () => {
      const { api } = createMockApi({ workspaceDir });
      const tools = createCommunicationTools(api);
      const markRead = tools.find((t) => t.name === "inbox_mark_read")!;

      await writeJson(join(workspaceDir, "agents", "cfo", "inbox.json"), [
        { id: "MSG-A", read: false },
        { id: "MSG-B", read: false },
      ]);

      await markRead.execute("test", {
        agent_id: "cfo",
        message_ids: ["MSG-A"],
      });

      const inbox = await readJson(join(workspaceDir, "agents", "cfo", "inbox.json"));
      expect(inbox[0].read).toBe(true);
      expect(inbox[1].read).toBe(false);
    });
  });
});
