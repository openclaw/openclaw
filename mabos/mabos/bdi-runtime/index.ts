/**
 * MABOS BDI Runtime — Background Service
 *
 * Registers a background service that runs periodic BDI cycles
 * for all active agents. This is the deep integration that was
 * not possible as a plugin — background services require
 * `api.registerService()`.
 *
 * The BDI heartbeat:
 *  1. Scans workspace for active agents
 *  2. For each agent, reads cognitive state (beliefs, desires, goals, intentions)
 *  3. Evaluates desire priority changes based on new beliefs
 *  4. Prunes stale intentions (respecting commitment strategy)
 *  5. Writes updated cognitive state back
 */

import { readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Cognitive file names in each agent directory. */
const COGNITIVE_FILES = {
  beliefs: "Beliefs.md",
  desires: "Desires.md",
  goals: "Goals.md",
  intentions: "Intentions.md",
  plans: "Plans.md",
  skills: "Skill.md",
  tasks: "Task.md",
  actions: "Actions.md",
  commitments: "Commitments.md",
  memory: "Memory.md",
  persona: "Persona.md",
  capabilities: "Capabilities.md",
  learnings: "Learnings.md",
} as const;

/** R5: Maximum sections per chunk for recursive belief processing. */
const BELIEF_CHUNK_SIZE = 50;

/**
 * R5: Process belief content in chunks for large belief bases.
 */
async function _processBeliefChunks(
  beliefs: string,
  processor: (chunk: string) => Promise<{ pruned: number; updated: string }>,
  chunkSize: number = BELIEF_CHUNK_SIZE,
): Promise<{ totalPruned: number; result: string }> {
  const sections = beliefs.split(/(?=^##\s)/m).filter(Boolean);
  if (sections.length <= chunkSize) {
    const r = await processor(beliefs);
    return { totalPruned: r.pruned, result: r.updated };
  }
  const chunks: string[] = [];
  for (let i = 0; i < sections.length; i += chunkSize) {
    chunks.push(sections.slice(i, i + chunkSize).join("\n"));
  }
  let totalPruned = 0;
  const processed: string[] = [];
  for (const chunk of chunks) {
    const result = await processor(chunk);
    totalPruned += result.pruned;
    processed.push(result.updated);
  }
  return { totalPruned, result: processed.join("\n") };
}

/**
 * R5: Detect conflicting beliefs within a belief document.
 * Compares belief blocks — if two beliefs about the same subject
 * have conflicting values and both have high certainty, flag as conflict.
 */
function detectBeliefConflicts(beliefs: string): Array<{
  belief1: string;
  belief2: string;
  reason: string;
}> {
  const blocks = beliefs.split(/(?=^##\s)/m).filter(Boolean);
  const conflicts: Array<{ belief1: string; belief2: string; reason: string }> = [];

  // Extract subject and certainty from each block
  const parsed = blocks.map((block) => {
    const heading =
      block
        .split("\n")[0]
        ?.replace(/^##\s*/, "")
        .trim() || "";
    const certaintyMatch = block.match(/certainty:\s*([.\d]+)/);
    const certainty = certaintyMatch ? parseFloat(certaintyMatch[1]) : 0.5;
    // Extract subject — first meaningful word cluster
    const subject = heading
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim();
    return { heading, subject, certainty, block: block.trim() };
  });

  // Compare pairs
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i];
      const b = parsed[j];
      // Same subject with high certainty on both sides
      if (
        a.subject &&
        b.subject &&
        a.subject === b.subject &&
        a.certainty > 0.6 &&
        b.certainty > 0.6
      ) {
        // Check if contents actually differ (not just duplicates)
        if (a.block !== b.block) {
          conflicts.push({
            belief1: a.heading,
            belief2: b.heading,
            reason: `Both have high certainty (${a.certainty}, ${b.certainty}) but different content`,
          });
        }
      }
    }
  }

  return conflicts;
}

/** BDI configuration from agent.json. */
export interface AgentBdiConfig {
  commitmentStrategy?: "single-minded" | "open-minded" | "cautious";
  cycleFrequency?: {
    fullCycleMinutes?: number;
    quickCheckMinutes?: number;
  };
  reasoningMethods?: string[];
}

/** Parsed contents of an agent's agent.json file. */
export interface AgentManifest {
  id: string;
  name?: string;
  bdi?: AgentBdiConfig;
}

export interface BdiAgentState {
  agentId: string;
  agentDir: string;
  beliefs: string;
  desires: string;
  goals: string;
  intentions: string;
  lastCycleAt: string | null;
  /** Parsed BDI config from agent.json (undefined if no agent.json). */
  bdiConfig?: AgentBdiConfig;
}

export interface BdiCycleResult {
  agentId: string;
  staleIntentionsPruned: number;
  desiresPrioritized: number;
  conflictsDetected: number;
  chunksProcessed: number;
  unreadMessages: number;
  urgentMessages: number;
  timestamp: string;
}

/**
 * Read agent.json from an agent directory. Returns undefined if missing or invalid.
 */
async function readAgentManifest(agentDir: string): Promise<AgentManifest | undefined> {
  try {
    const raw = await readFile(join(agentDir, "agent.json"), "utf-8");
    return JSON.parse(raw) as AgentManifest;
  } catch {
    return undefined;
  }
}

/**
 * Read the cognitive state for a single agent.
 */
export async function readAgentCognitiveState(
  agentDir: string,
  agentId: string,
): Promise<BdiAgentState> {
  const read = async (file: string) => {
    try {
      return await readFile(join(agentDir, file), "utf-8");
    } catch {
      return "";
    }
  };

  const manifest = await readAgentManifest(agentDir);

  return {
    agentId,
    agentDir,
    beliefs: await read(COGNITIVE_FILES.beliefs),
    desires: await read(COGNITIVE_FILES.desires),
    goals: await read(COGNITIVE_FILES.goals),
    intentions: await read(COGNITIVE_FILES.intentions),
    lastCycleAt: null,
    bdiConfig: manifest?.bdi,
  };
}

/**
 * Run a lightweight BDI maintenance cycle on an agent's cognitive state.
 * This is the background "heartbeat" — it doesn't make decisions, it
 * maintains cognitive hygiene (prune stale intentions, re-sort desires).
 *
 * Commitment strategy affects intention pruning aggressiveness:
 *  - single-minded: only expire intentions past deadline
 *  - open-minded (default): expire past deadline + stalled >7 days
 *  - cautious: expire past deadline + stalled >3 days
 */
export async function runMaintenanceCycle(state: BdiAgentState): Promise<BdiCycleResult> {
  let staleIntentionsPruned = 0;
  let desiresPrioritized = 0;

  const strategy = state.bdiConfig?.commitmentStrategy ?? "open-minded";
  // Stall threshold: how many days without progress before marking stale
  const stallDays = strategy === "single-minded" ? Infinity : strategy === "cautious" ? 3 : 7;

  // --- Prune stale intentions ---
  if (state.intentions) {
    const lines = state.intentions.split("\n");
    const now = new Date();
    const filteredLines: string[] = [];

    for (const line of lines) {
      // Detect deadline markers like [deadline: 2026-02-15]
      const deadlineMatch = line.match(/\[deadline:\s*(\d{4}-\d{2}-\d{2})\]/);
      if (deadlineMatch) {
        const deadline = new Date(deadlineMatch[1]);
        if (deadline < now && line.includes("status: active")) {
          // Mark as expired rather than deleting
          filteredLines.push(line.replace("status: active", "status: expired"));
          staleIntentionsPruned++;
          continue;
        }
      }

      // Check for stalled intentions (last-updated older than threshold)
      if (stallDays < Infinity && line.includes("status: active")) {
        const updatedMatch = line.match(/\[updated:\s*(\d{4}-\d{2}-\d{2})\]/);
        if (updatedMatch) {
          const updated = new Date(updatedMatch[1]);
          const daysSinceUpdate = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceUpdate > stallDays) {
            filteredLines.push(line.replace("status: active", "status: stalled"));
            staleIntentionsPruned++;
            continue;
          }
        }
      }

      filteredLines.push(line);
    }

    if (staleIntentionsPruned > 0) {
      const updated = filteredLines.join("\n");
      await writeFile(join(state.agentDir, COGNITIVE_FILES.intentions), updated, "utf-8");
    }
  }

  // --- Re-sort desires by priority ---
  if (state.desires) {
    const desireBlocks = state.desires.split(/(?=^##\s)/m).filter(Boolean);
    if (desireBlocks.length > 1) {
      // Extract priority from each block
      const scored = desireBlocks.map((block) => {
        const priorityMatch = block.match(/priority:\s*([\d.]+)/);
        const priority = priorityMatch ? parseFloat(priorityMatch[1]) : 0.5;
        return { block, priority };
      });

      // Sort descending by priority
      scored.sort((a, b) => b.priority - a.priority);
      desiresPrioritized = scored.length;

      const sorted = scored.map((s) => s.block).join("\n");
      if (sorted !== state.desires) {
        await writeFile(join(state.agentDir, COGNITIVE_FILES.desires), sorted, "utf-8");
      }
    }
  }

  // --- R5: Chunked belief processing ---
  let chunksProcessed = 0;
  if (state.beliefs) {
    const beliefSections = state.beliefs.split(/(?=^##\s)/m).filter(Boolean);
    chunksProcessed = Math.ceil(beliefSections.length / BELIEF_CHUNK_SIZE);
  }

  // --- R5: Detect belief conflicts ---
  let conflictsDetected = 0;
  if (state.beliefs) {
    const conflicts = detectBeliefConflicts(state.beliefs);
    conflictsDetected = conflicts.length;

    if (conflicts.length > 0) {
      // Write conflict report
      const { mkdir, writeFile: writeFileFs } = await import("node:fs/promises");
      const conflictDir = join(state.agentDir, "memory", "bdi-conflicts");
      await mkdir(conflictDir, { recursive: true });
      const dateStr = new Date().toISOString().split("T")[0];
      const reportPath = join(conflictDir, `${dateStr}.md`);

      const report = [
        `# BDI Conflict Report — ${dateStr}`,
        "",
        `> ${conflicts.length} conflict(s) detected during maintenance cycle.`,
        "",
        ...conflicts.map((c, i) =>
          [
            `## Conflict ${i + 1}`,
            `- **Belief A:** ${c.belief1}`,
            `- **Belief B:** ${c.belief2}`,
            `- **Reason:** ${c.reason}`,
            "",
          ].join("\n"),
        ),
      ].join("\n");

      await writeFileFs(reportPath, report, "utf-8");
    }
  }

  // --- Inbox processing: count unread and urgent messages ---
  let unreadMessages = 0;
  let urgentMessages = 0;
  try {
    const inboxPath = join(state.agentDir, "inbox.json");
    const inboxRaw = await readFile(inboxPath, "utf-8");
    const inbox: Array<{
      id: string;
      from: string;
      performative: string;
      content: string;
      read: boolean;
      priority: string;
    }> = JSON.parse(inboxRaw);
    unreadMessages = inbox.filter((m) => !m.read).length;
    urgentMessages = inbox.filter(
      (m) => !m.read && (m.priority === "urgent" || m.priority === "high"),
    ).length;

    // If urgent messages exist, append a transient belief section
    if (urgentMessages > 0) {
      const beliefPath = join(state.agentDir, COGNITIVE_FILES.beliefs);
      let beliefs = state.beliefs || "";
      // Remove any existing transient communications section
      beliefs = beliefs.replace(
        /\n## Pending Communications \[transient\][\s\S]*?(?=\n## |\n*$)/,
        "",
      );
      const urgentEntries = inbox
        .filter((m) => !m.read && (m.priority === "urgent" || m.priority === "high"))
        .slice(0, 5)
        .map(
          (m) =>
            `- ${m.id} from ${m.from} [${m.performative}] (${m.priority}): ${(m.content || "").slice(0, 100)}`,
        );
      beliefs += `\n## Pending Communications [transient]\n> ${urgentMessages} urgent/high-priority unread message(s)\n${urgentEntries.join("\n")}\n`;
      await writeFile(beliefPath, beliefs, "utf-8");
    }
  } catch {
    // No inbox or invalid — counts stay 0
  }

  return {
    agentId: state.agentId,
    staleIntentionsPruned,
    desiresPrioritized,
    conflictsDetected,
    chunksProcessed,
    unreadMessages,
    urgentMessages,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Discover all agent directories in a workspace.
 */
export async function discoverAgents(workspaceDir: string): Promise<string[]> {
  const agentsDir = join(workspaceDir, "agents");
  try {
    const entries = await readdir(agentsDir);
    const agents: string[] = [];
    for (const entry of entries) {
      const entryPath = join(agentsDir, entry);
      const s = await stat(entryPath).catch(() => null);
      if (s?.isDirectory()) {
        // Verify it has at least one cognitive file
        const hasPersona = await stat(join(entryPath, COGNITIVE_FILES.persona)).catch(() => null);
        const hasBeliefs = await stat(join(entryPath, COGNITIVE_FILES.beliefs)).catch(() => null);
        if (hasPersona || hasBeliefs) {
          agents.push(entry);
        }
      }
    }
    return agents;
  } catch {
    return [];
  }
}

/**
 * Get a summary of all agents' cognitive state (for CLI display).
 */
export async function getAgentsSummary(workspaceDir: string): Promise<
  Array<{
    agentId: string;
    beliefCount: number;
    goalCount: number;
    intentionCount: number;
    desireCount: number;
    commitmentStrategy?: string;
  }>
> {
  const agents = await discoverAgents(workspaceDir);
  const summaries: Array<{
    agentId: string;
    beliefCount: number;
    goalCount: number;
    intentionCount: number;
    desireCount: number;
    commitmentStrategy?: string;
  }> = [];

  for (const agentId of agents) {
    const agentDir = join(workspaceDir, "agents", agentId);
    const state = await readAgentCognitiveState(agentDir, agentId);

    const countHeadings = (md: string) => (md.match(/^##\s/gm) || []).length;

    summaries.push({
      agentId,
      beliefCount: countHeadings(state.beliefs),
      goalCount: countHeadings(state.goals),
      intentionCount: countHeadings(state.intentions),
      desireCount: countHeadings(state.desires),
      commitmentStrategy: state.bdiConfig?.commitmentStrategy,
    });
  }

  return summaries;
}

/**
 * Create the BDI background service definition for registerService().
 */
export function createBdiService(opts: {
  workspaceDir: string;
  intervalMinutes: number;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  async function tick() {
    const agents = await discoverAgents(opts.workspaceDir);
    if (agents.length === 0) {
      return;
    }

    // Check for wake-up markers — prioritize woken agents
    const wokeAgents = new Set<string>();
    for (const agentId of agents) {
      const wakeUpPath = join(opts.workspaceDir, "agents", agentId, "wake-up.json");
      try {
        const wakeUp = JSON.parse(await readFile(wakeUpPath, "utf-8"));
        wokeAgents.add(agentId);
        opts.logger.info(
          `[mabos-bdi] Wake-up marker found for ${agentId}: ${wakeUp.reason || "high-priority message"}`,
        );
        // Delete marker after reading
        await unlink(wakeUpPath).catch(() => {});
      } catch {
        // No wake-up marker
      }
    }

    // Process woken agents first, then the rest
    const sortedAgents = [
      ...agents.filter((a) => wokeAgents.has(a)),
      ...agents.filter((a) => !wokeAgents.has(a)),
    ];

    let totalPruned = 0;
    let totalPrioritized = 0;
    let totalConflicts = 0;
    let totalUnread = 0;
    let totalUrgent = 0;

    for (const agentId of sortedAgents) {
      const agentDir = join(opts.workspaceDir, "agents", agentId);
      try {
        const state = await readAgentCognitiveState(agentDir, agentId);
        const result = await runMaintenanceCycle(state);
        totalPruned += result.staleIntentionsPruned;
        totalPrioritized += result.desiresPrioritized;
        totalConflicts += result.conflictsDetected;
        totalUnread += result.unreadMessages;
        totalUrgent += result.urgentMessages;
      } catch {
        // Skip individual agent errors
      }
    }

    if (totalPruned > 0 || totalPrioritized > 0 || totalConflicts > 0 || totalUnread > 0) {
      opts.logger.info(
        `[mabos-bdi] Cycle complete: ${agents.length} agents, ${totalPruned} intentions pruned, ${totalPrioritized} desires re-sorted, ${totalConflicts} conflicts detected, ${totalUnread} unread msgs (${totalUrgent} urgent)${wokeAgents.size > 0 ? `, ${wokeAgents.size} woken` : ""}`,
      );
    }
  }

  return {
    id: "mabos-bdi-heartbeat",
    start: async () => {
      opts.logger.info(
        `[mabos-bdi] BDI heartbeat started (interval: ${opts.intervalMinutes}min, workspace: ${opts.workspaceDir})`,
      );
      // Run once immediately
      await tick().catch(() => {});
      // Then on interval
      intervalHandle = setInterval(
        () => {
          tick().catch(() => {});
        },
        opts.intervalMinutes * 60 * 1000,
      );
      intervalHandle.unref?.();
    },
    stop: async () => {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      opts.logger.info("[mabos-bdi] BDI heartbeat stopped");
    },
  };
}
