import type { AnyAgentTool, BotPluginApi, BotPluginService } from "bot/plugin-sdk";
import { emptyPluginConfigSchema } from "bot/plugin-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Continuous Learning Extension
 *
 * Bridges bot telemetry to our GRPO (Group-wise Relative Policy Optimization)
 * research pipeline for training-free continuous improvement.
 *
 * This extension implements the client-side of the full research stack:
 *
 *   zoo-gym SemanticExtractor     → 3-stage LLM analysis (Tencent YouTou-Agent, arXiv:2510.08191v1)
 *   zoo-gym ExperienceManager     → CRUD on semantic experience library E
 *   zoo-gym SemanticMemoryManager → Embedding-based retrieval + hybrid compression
 *   zoo-gym LocalDSOOptimizer     → Full optimization loop + BitDelta compression (ZIP-007)
 *   zoo-gym BitDeltaQuantizer     → 1-bit quantization for P2P experience sharing
 *
 * Protocols:
 *   ASO  (HIP-002)   — Active Semantic Optimization (single-node)
 *   DSO  (ZIP-001/400)— Decentralized Semantic Optimization (federated)
 *   PoAI (ZIP-002)    — Proof of AI consensus for verifiable compute
 *
 * Architecture:
 *   Agent session → Tool telemetry → Semantic extraction → Experience library
 *     → BitDelta compression → DSO network sharing → Better prompts next session
 *
 * The backend runs in zoo-gym (Python) or hanzo-llm (Rust). This extension
 * calls the Hanzo Cloud API which proxies to whichever backend is active.
 */

// ────────────────────────────────────────────────────────────────────────────
// Types matching zoo-gym's data model
// ────────────────────────────────────────────────────────────────────────────

interface Experience {
  exp_id: string;
  text: string;
  confidence: number;
  domain: string;
  created_epoch: number;
  usage_count: number;
  last_used_epoch?: number;
}

interface SemanticOperation {
  option: "add" | "delete" | "modify" | "merge" | "keep";
  experience?: string;
  modified_from?: string;
  delete_id?: string;
  merged_from?: string[];
}

interface Trajectory {
  query: string;
  output: string;
  reward: number;
  groundtruth?: string;
  summary?: string;
}

interface CompressedBatch {
  node_id: string;
  timestamp: number;
  experiences: Record<
    string,
    {
      text: string;
      signs: number[];
      scale: number;
      shape: number[];
      confidence: number;
      domain: string;
    }
  >;
  hash: string;
}

interface MemoryStats {
  total_experiences: number;
  avg_confidence: number;
  domains: Record<string, number>;
  avg_age: number;
  embedding_coverage: number;
}

interface GRPOConfig {
  /** Hanzo Cloud GRPO endpoint */
  endpoint: string;
  /** API key */
  apiKey?: string;
  /** Enable GRPO enhancement */
  enabled: boolean;
  /** Number of rollouts per query (G parameter from paper) */
  groupSize: number;
  /** Minimum reward variance to trigger semantic extraction */
  extractionThreshold: number;
  /** Max experience library size before compression */
  maxExperiences: number;
  /** BitDelta bits (1-bit = 10× compression, ZIP-007) */
  bitdeltaBits: number;
  /** BitDelta group size for quantization */
  bitdeltaGroupSize: number;
  /** Memory compression strategy (matches zoo-gym) */
  compressionStrategy: "diversity" | "importance" | "temporal" | "hybrid";
  /** Enable DSO (Decentralized Semantic Optimization, ZIP-001) for P2P sharing */
  dsoEnabled: boolean;
  /** Minimum confidence for DSO network broadcast */
  dsoNetworkThreshold: number;
}

const DEFAULT_CONFIG: GRPOConfig = {
  endpoint: process.env.HANZO_CLOUD_URL ?? "https://api.hanzo.ai",
  apiKey: process.env.HANZO_API_KEY,
  enabled: true,
  groupSize: 5,
  extractionThreshold: 0.1,
  maxExperiences: 200,
  bitdeltaBits: 1,
  bitdeltaGroupSize: 128,
  compressionStrategy: "hybrid",
  dsoEnabled: process.env.DSO_ENABLED === "true",
  dsoNetworkThreshold: 0.7,
};

// ────────────────────────────────────────────────────────────────────────────
// Local experience cache (for offline/fallback)
// ────────────────────────────────────────────────────────────────────────────

let localExperiences: Map<string, Experience> = new Map();
let localExperiencesDir: string | null = null;
let nextLocalId = 0;

function initLocalCache(api: BotPluginApi): void {
  const dir = api.resolvePath("~/.hanzo/bot/continuous-learning");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  localExperiencesDir = dir;

  const cachePath = join(dir, "experiences.json");
  if (existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf-8"));
      for (const exp of data.experiences ?? []) {
        localExperiences.set(exp.exp_id, exp);
        const num = parseInt(exp.exp_id.replace("G", ""), 10);
        if (!isNaN(num) && num >= nextLocalId) nextLocalId = num + 1;
      }
    } catch {
      // Corrupted cache, start fresh
    }
  }
}

function saveLocalCache(): void {
  if (!localExperiencesDir) return;
  try {
    writeFileSync(
      join(localExperiencesDir, "experiences.json"),
      JSON.stringify(
        {
          saved_at: new Date().toISOString(),
          experiences: Array.from(localExperiences.values()),
        },
        null,
        2,
      ),
    );
  } catch {
    // Best-effort
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Plugin
// ────────────────────────────────────────────────────────────────────────────

const plugin = {
  id: "continuous-learning",
  name: "Continuous Learning (GRPO + DSO)",
  description:
    "Training-free continuous improvement via GRPO experience management (Tencent YouTou-Agent). " +
    "Semantic extraction pipeline, embedding-based retrieval, BitDelta compression (ZIP-007), " +
    "and optional DSO (ZIP-001) for federated experience sharing across agent nodes.",
  configSchema: emptyPluginConfigSchema(),

  register(api: BotPluginApi) {
    // Initialize local experience cache
    initLocalCache(api);

    // Register tools
    api.registerTool(createExperienceTool(api));
    api.registerTool(createGRPOCompletionTool(api));
    api.registerTool(createDSOTool(api));

    // Register background consolidation service
    api.registerService(createConsolidationService(api));

    // Hook: after successful agent sessions, run 3-stage semantic extraction
    api.on(
      "agent_end",
      async (event: any, _ctx: any) => {
        if (!event.success) return;
        try {
          await extractSessionExperiences(api, event);
        } catch {
          // Best-effort; never block agent completion
        }
      },
      { priority: 10 },
    );

    // Hook: inject relevant experiences into agent context (ASO, HIP-002)
    api.on(
      "before_agent_start",
      async (event: any, _ctx: any) => {
        try {
          const query = event?.task ?? event?.message ?? "";
          const experiences = await getRelevantExperiences(api, query);
          if (experiences.length === 0) return {};

          const lines: string[] = [];
          lines.push("## Learned Experiences (GRPO/ASO)");
          lines.push("");
          for (const exp of experiences.slice(0, 10)) {
            lines.push(
              `- [${exp.exp_id}] (${exp.domain}, conf:${exp.confidence.toFixed(2)}) ${exp.text}`,
            );
          }

          return { prependContext: lines.join("\n") };
        } catch {
          return {};
        }
      },
      { priority: 40 },
    );
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Tool: grpo_experiences — Manage the experience library
// ────────────────────────────────────────────────────────────────────────────

function createExperienceTool(_api: BotPluginApi): AnyAgentTool {
  return {
    name: "grpo_experiences",
    label: "GRPO Experiences",
    description:
      "Manage the GRPO experience library (semantic memory for training-free improvement). " +
      "Backed by zoo-gym's SemanticMemoryManager with embedding-based retrieval. " +
      "Actions: list, add, consolidate, stats, retrieve (semantic search), compress.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "consolidate", "stats", "retrieve", "compress"],
          description:
            "list: show experiences. add: new insight (max 32 words). " +
            "consolidate: merge/prune via SemanticExtractor. stats: library metrics. " +
            "retrieve: semantic search for query. compress: run memory compression.",
        },
        text: {
          type: "string",
          description: "Experience text for 'add', or query for 'retrieve'",
        },
        domain: {
          type: "string",
          description: "Domain tag (coding, devops, marketing, research, general)",
        },
        confidence: {
          type: "number",
          description: "Confidence score 0-1 for 'add' (default: 0.7)",
        },
        top_k: {
          type: "number",
          description: "Number of results for 'retrieve' (default: 5)",
        },
        strategy: {
          type: "string",
          enum: ["diversity", "importance", "temporal", "hybrid"],
          description: "Compression strategy (default: hybrid)",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: any) {
      const action = params.action as string;
      const config = DEFAULT_CONFIG;

      switch (action) {
        case "list":
          return await listExperiences(config);
        case "add": {
          if (!params.text) {
            return { content: [{ type: "text", text: "Missing 'text' parameter" }] };
          }
          return await addExperience(
            config,
            params.text,
            params.domain ?? "general",
            params.confidence ?? 0.7,
          );
        }
        case "consolidate":
          return await consolidateExperiences(config);
        case "stats":
          return await getExperienceStats(config);
        case "retrieve": {
          if (!params.text) {
            return { content: [{ type: "text", text: "Missing 'text' (query) parameter" }] };
          }
          return await retrieveExperiences(config, params.text, params.top_k ?? 5, params.domain);
        }
        case "compress":
          return await compressExperiences(config, params.strategy ?? "hybrid");
        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
      }
    },
  } as AnyAgentTool;
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: grpo_completion — GRPO-enhanced LLM completion
// ────────────────────────────────────────────────────────────────────────────

function createGRPOCompletionTool(_api: BotPluginApi): AnyAgentTool {
  return {
    name: "grpo_completion",
    label: "GRPO Completion",
    description:
      "Run a GRPO-enhanced LLM completion (multi-rollout + reward + best response). " +
      "Uses zoo-gym's SemanticExtractor pipeline: G rollouts → reward scoring → " +
      "semantic advantage extraction → experience library update. " +
      "Optionally provide groundtruth for supervised learning.",
    parameters: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "The prompt to complete" },
        model: { type: "string", description: "Model to use (default: from config)" },
        groundtruth: {
          type: "string",
          description: "Optional correct answer for reward computation and semantic extraction",
        },
        group_size: {
          type: "number",
          description: "Number of rollouts G (default: 5). Higher = better extraction, more cost.",
        },
        extract_experiences: {
          type: "boolean",
          description: "Run semantic extraction after completion (default: true)",
        },
      },
      required: ["prompt"],
    },
    async execute(_toolCallId: string, params: any) {
      const config = DEFAULT_CONFIG;

      try {
        const response = await fetch(`${config.endpoint}/v1/grpo/complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            prompt: params.prompt,
            model: params.model ?? "default",
            group_size: params.group_size ?? config.groupSize,
            extraction_threshold: config.extractionThreshold,
            extract_experiences: params.extract_experiences ?? true,
            ...(params.groundtruth ? { groundtruth: params.groundtruth } : {}),
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          return {
            content: [{ type: "text", text: `GRPO completion failed: ${response.status} ${text}` }],
          };
        }

        const data = await response.json();
        const bestChoice = data.best_response ?? data.choices?.[0]?.message?.content;
        const grpoMeta = data.grpo_metadata;

        const lines: string[] = [];
        if (bestChoice) {
          lines.push(typeof bestChoice === "string" ? bestChoice : bestChoice.content);
        }

        if (grpoMeta) {
          lines.push("");
          lines.push("---");
          lines.push(
            `GRPO: G=${grpoMeta.group_size ?? "?"}, ` +
              `${grpoMeta.experiences_used ?? 0} experiences injected, ` +
              `best reward: ${grpoMeta.best_reward?.toFixed(3) ?? "N/A"}, ` +
              `avg reward: ${grpoMeta.avg_reward?.toFixed(3) ?? "N/A"}, ` +
              `variance: ${grpoMeta.reward_variance?.toFixed(4) ?? "N/A"}`,
          );
          if (grpoMeta.operations_applied) {
            lines.push(
              `Extraction: ${grpoMeta.operations_applied} ops ` +
                `(${grpoMeta.experiences_added ?? 0} added, ` +
                `${grpoMeta.experiences_modified ?? 0} modified, ` +
                `${grpoMeta.experiences_deleted ?? 0} deleted)`,
            );
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `GRPO completion error: ${err.message}` }] };
      }
    },
  } as AnyAgentTool;
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: dso_network — DSO (Decentralized Semantic Optimization) operations
// ────────────────────────────────────────────────────────────────────────────

function createDSOTool(_api: BotPluginApi): AnyAgentTool {
  return {
    name: "dso_network",
    label: "DSO Network",
    description:
      "Manage DSO (Decentralized Semantic Optimization, ZIP-001/400) for federated " +
      "experience sharing. Compresses experiences with BitDelta (ZIP-007, 10× compression) " +
      "and shares via DeltaSoup (Byzantine-robust aggregation) across agent nodes. " +
      "Actions: status, broadcast, receive, peers.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["status", "broadcast", "receive", "peers"],
          description:
            "status: DSO network status. broadcast: push high-confidence experiences. " +
            "receive: pull experiences from peers. peers: list connected nodes.",
        },
        min_confidence: {
          type: "number",
          description: "Minimum confidence for broadcast (default: 0.7)",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: any) {
      const config = DEFAULT_CONFIG;

      if (!config.dsoEnabled) {
        return {
          content: [
            {
              type: "text",
              text: "DSO is disabled. Set DSO_ENABLED=true to enable decentralized experience sharing.",
            },
          ],
        };
      }

      try {
        const response = await fetch(`${config.endpoint}/v1/dso/${params.action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            min_confidence: params.min_confidence ?? config.dsoNetworkThreshold,
            bitdelta_bits: config.bitdeltaBits,
            bitdelta_group_size: config.bitdeltaGroupSize,
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          return {
            content: [
              { type: "text", text: `DSO ${params.action} failed: ${response.status} ${text}` },
            ],
          };
        }

        const data = await response.json();
        return { content: [{ type: "text", text: formatDSOResponse(params.action, data) }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `DSO error: ${err.message}` }] };
      }
    },
  } as AnyAgentTool;
}

function formatDSOResponse(action: string, data: any): string {
  switch (action) {
    case "status":
      return [
        "## DSO Network Status",
        `Node ID: ${data.node_id ?? "unknown"}`,
        `Connected peers: ${data.peer_count ?? 0}`,
        `Local experiences: ${data.local_count ?? 0}`,
        `Shared experiences: ${data.shared_count ?? 0}`,
        `BitDelta compression: ${data.compression_ratio ?? "N/A"}×`,
        `Last sync: ${data.last_sync ?? "never"}`,
      ].join("\n");
    case "broadcast":
      return [
        "## DSO Broadcast",
        `Experiences broadcast: ${data.broadcast_count ?? 0}`,
        `BitDelta compressed size: ${data.compressed_bytes ?? 0} bytes`,
        `Peers reached: ${data.peers_reached ?? 0}`,
        data.hash ? `Integrity hash: ${data.hash}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "receive":
      return [
        "## DSO Receive",
        `New experiences received: ${data.received_count ?? 0}`,
        `From ${data.source_peers ?? 0} peers`,
        `DeltaSoup aggregation: ${data.aggregation_mode ?? "N/A"}`,
        `Byzantine filtering: ${data.filtered_count ?? 0} rejected`,
      ].join("\n");
    case "peers":
      return [
        "## DSO Peers",
        ...(data.peers ?? []).map(
          (p: any) => `- ${p.node_id} (${p.experience_count} exps, last seen: ${p.last_seen})`,
        ),
        data.peers?.length === 0 ? "No connected peers." : "",
      ]
        .filter(Boolean)
        .join("\n");
    default:
      return JSON.stringify(data, null, 2);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Background service: periodic consolidation + DSO sync
// ────────────────────────────────────────────────────────────────────────────

function createConsolidationService(_api: BotPluginApi): BotPluginService {
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    id: "grpo-consolidation",
    async start(ctx) {
      // Consolidate + DSO sync every 30 minutes
      timer = setInterval(
        async () => {
          try {
            const config = DEFAULT_CONFIG;
            if (!config.enabled || !config.apiKey) return;

            // Consolidate via SemanticExtractor's batch consolidation
            await consolidateExperiences(config);
            ctx.logger.info("[GRPO] Experience library consolidated");

            // DSO broadcast if enabled
            if (config.dsoEnabled) {
              try {
                await fetch(`${config.endpoint}/v1/dso/broadcast`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
                  },
                  body: JSON.stringify({
                    min_confidence: config.dsoNetworkThreshold,
                    bitdelta_bits: config.bitdeltaBits,
                    bitdelta_group_size: config.bitdeltaGroupSize,
                  }),
                });
                ctx.logger.info("[DSO] Experience broadcast complete");
              } catch {
                // DSO failures are non-critical
              }
            }
          } catch {
            // Best-effort
          }
        },
        30 * 60 * 1000,
      );
      ctx.logger.info(
        `[GRPO] Consolidation service started (30min interval, DSO: ${DEFAULT_CONFIG.dsoEnabled ? "on" : "off"})`,
      );
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Save local cache on shutdown
      saveLocalCache();
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Session experience extraction (3-stage pipeline)
// ────────────────────────────────────────────────────────────────────────────

async function extractSessionExperiences(api: BotPluginApi, event: any): Promise<void> {
  const config = DEFAULT_CONFIG;
  if (!config.enabled || !config.apiKey) return;

  // Build trajectories from session tool calls
  const trajectories: Trajectory[] = [];
  for (const call of event.tool_calls ?? []) {
    trajectories.push({
      query: call.input ?? "",
      output: call.output ?? "",
      reward: call.success ? 1.0 : 0.0,
      groundtruth: call.expected_output,
    });
  }

  if (trajectories.length === 0) return;

  try {
    // Send to backend for 3-stage semantic extraction:
    // Stage 1: summarize_trajectory (per trajectory)
    // Stage 2: extract_group_advantage (compare within group)
    // Stage 3: consolidate_batch (merge across groups)
    const response = await fetch(`${config.endpoint}/v1/grpo/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        trajectories,
        session_id: event.session_id,
        extraction_threshold: config.extractionThreshold,
      }),
    });

    if (!response.ok) return;

    const data = await response.json();
    const operations: SemanticOperation[] = data.operations ?? [];

    // Apply operations to local cache
    for (const op of operations) {
      switch (op.option) {
        case "add":
          if (op.experience) {
            const id = `G${nextLocalId++}`;
            localExperiences.set(id, {
              exp_id: id,
              text: op.experience,
              confidence: 0.7,
              domain: "general",
              created_epoch: Date.now(),
              usage_count: 0,
            });
          }
          break;
        case "delete":
          if (op.delete_id) {
            localExperiences.delete(op.delete_id);
          }
          break;
        case "modify":
          if (op.modified_from && op.experience) {
            const existing = localExperiences.get(op.modified_from);
            if (existing) {
              existing.text = op.experience;
            }
          }
          break;
        case "merge":
          if (op.merged_from && op.experience) {
            for (const mId of op.merged_from) {
              localExperiences.delete(mId);
            }
            const id = `G${nextLocalId++}`;
            localExperiences.set(id, {
              exp_id: id,
              text: op.experience,
              confidence: 0.8,
              domain: "general",
              created_epoch: Date.now(),
              usage_count: 0,
            });
          }
          break;
      }
    }

    saveLocalCache();
    api.logger.info(
      `[GRPO] Session extraction: ${operations.length} ops (${data.added ?? 0} added, ${data.deleted ?? 0} deleted)`,
    );
  } catch {
    // Best-effort extraction
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Experience retrieval (semantic search via backend embeddings)
// ────────────────────────────────────────────────────────────────────────────

async function getRelevantExperiences(_api: BotPluginApi, query: string): Promise<Experience[]> {
  const config = DEFAULT_CONFIG;

  // Try backend semantic retrieval first (uses SemanticMemoryManager embeddings)
  if (config.enabled && config.apiKey) {
    try {
      const response = await fetch(`${config.endpoint}/v1/grpo/experiences/retrieve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ query, top_k: 10 }),
      });
      if (response.ok) {
        const data = await response.json();
        return data.experiences ?? [];
      }
    } catch {
      // Fall through to local cache
    }
  }

  // Fallback: return all local experiences (no semantic ranking)
  return Array.from(localExperiences.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────────
// API functions
// ────────────────────────────────────────────────────────────────────────────

async function listExperiences(config: GRPOConfig) {
  try {
    const response = await fetch(`${config.endpoint}/v1/grpo/experiences`, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });
    if (!response.ok) {
      // Fallback to local cache
      return formatLocalExperiences();
    }
    const data = await response.json();
    const exps: Experience[] = data.experiences ?? [];
    if (exps.length === 0) {
      return formatLocalExperiences();
    }
    const lines = exps.map(
      (e) => `- [${e.exp_id}] (${e.domain}, conf:${e.confidence.toFixed(2)}) ${e.text}`,
    );
    return {
      content: [
        { type: "text", text: `## Experience Library (${exps.length})\n\n${lines.join("\n")}` },
      ],
    };
  } catch {
    return formatLocalExperiences();
  }
}

function formatLocalExperiences() {
  if (localExperiences.size === 0) {
    return { content: [{ type: "text", text: "Experience library is empty." }] };
  }
  const lines = Array.from(localExperiences.values()).map(
    (e) => `- [${e.exp_id}] (${e.domain}, conf:${e.confidence.toFixed(2)}) ${e.text}`,
  );
  return {
    content: [
      {
        type: "text",
        text: `## Experience Library — Local Cache (${localExperiences.size})\n\n${lines.join("\n")}`,
      },
    ],
  };
}

async function addExperience(config: GRPOConfig, text: string, domain: string, confidence: number) {
  const words = text.split(/\s+/);
  if (words.length > 32) {
    return {
      content: [
        {
          type: "text",
          text: "Experience must be 32 words or fewer (matches zoo-gym constraint).",
        },
      ],
    };
  }

  // Add to local cache immediately
  const localId = `G${nextLocalId++}`;
  localExperiences.set(localId, {
    exp_id: localId,
    text,
    confidence,
    domain,
    created_epoch: Date.now(),
    usage_count: 0,
  });
  saveLocalCache();

  // Also push to backend
  try {
    await fetch(`${config.endpoint}/v1/grpo/experiences`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ text, domain, confidence }),
    });
  } catch {
    // Local cache is the source of truth
  }

  return {
    content: [
      {
        type: "text",
        text: `Experience added [${localId}]: "${text}" (${domain}, conf:${confidence})`,
      },
    ],
  };
}

async function retrieveExperiences(
  config: GRPOConfig,
  query: string,
  topK: number,
  domain?: string,
) {
  try {
    const response = await fetch(`${config.endpoint}/v1/grpo/experiences/retrieve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        query,
        top_k: topK,
        ...(domain ? { domain_filter: domain } : {}),
      }),
    });

    if (!response.ok) {
      return { content: [{ type: "text", text: `Retrieval failed: ${response.status}` }] };
    }

    const data = await response.json();
    const results = data.experiences ?? [];

    if (results.length === 0) {
      return { content: [{ type: "text", text: "No relevant experiences found." }] };
    }

    const lines = results.map(
      (r: any) =>
        `- [${r.exp_id}] (sim:${r.similarity?.toFixed(3) ?? "N/A"}, ${r.domain}) ${r.text}`,
    );
    return {
      content: [
        {
          type: "text",
          text: `## Semantic Search: "${query}" (top ${topK})\n\n${lines.join("\n")}`,
        },
      ],
    };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Retrieval error: ${err.message}` }] };
  }
}

async function consolidateExperiences(config: GRPOConfig) {
  try {
    const response = await fetch(`${config.endpoint}/v1/grpo/consolidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        strategy: config.compressionStrategy,
        max_size: config.maxExperiences,
      }),
    });
    if (!response.ok) {
      return { content: [{ type: "text", text: `Consolidation failed: ${response.status}` }] };
    }
    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text:
            `Experience library consolidated.\n` +
            `Operations: ${data.operations?.length ?? 0}\n` +
            `Library size: ${data.library_size ?? "?"}\n` +
            `Similar merged: ${data.merged_count ?? 0}\n` +
            `Strategy: ${config.compressionStrategy}`,
        },
      ],
    };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }] };
  }
}

async function compressExperiences(config: GRPOConfig, strategy: string) {
  try {
    const response = await fetch(`${config.endpoint}/v1/grpo/compress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        strategy,
        max_size: config.maxExperiences,
      }),
    });
    if (!response.ok) {
      return { content: [{ type: "text", text: `Compression failed: ${response.status}` }] };
    }
    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text:
            `## Memory Compression\n` +
            `Strategy: ${strategy}\n` +
            `Before: ${data.before_size ?? "?"} experiences\n` +
            `After: ${data.after_size ?? "?"} experiences\n` +
            `Removed: ${data.removed_count ?? 0}\n` +
            `Avg confidence: ${data.avg_confidence?.toFixed(3) ?? "N/A"}`,
        },
      ],
    };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }] };
  }
}

async function getExperienceStats(config: GRPOConfig) {
  try {
    const response = await fetch(`${config.endpoint}/v1/grpo/experiences/stats`, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });
    if (!response.ok) {
      // Fallback to local stats
      return formatLocalStats();
    }
    const stats: MemoryStats = await response.json();
    const lines = [
      `## Experience Library Stats`,
      `Total: ${stats.total_experiences}`,
      `Avg confidence: ${stats.avg_confidence?.toFixed(3) ?? "N/A"}`,
      `Domains: ${Object.entries(stats.domains ?? {})
        .map(([k, v]) => `${k}(${v})`)
        .join(", ")}`,
      `Avg age: ${stats.avg_age ?? "N/A"} epochs`,
      `Embedding coverage: ${((stats.embedding_coverage ?? 0) * 100).toFixed(1)}%`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch {
    return formatLocalStats();
  }
}

function formatLocalStats() {
  const exps = Array.from(localExperiences.values());
  const domains = new Map<string, number>();
  for (const e of exps) {
    domains.set(e.domain, (domains.get(e.domain) ?? 0) + 1);
  }
  const avgConf =
    exps.length > 0 ? exps.reduce((sum, e) => sum + e.confidence, 0) / exps.length : 0;

  return {
    content: [
      {
        type: "text",
        text: [
          `## Experience Library Stats (Local Cache)`,
          `Total: ${exps.length}`,
          `Avg confidence: ${avgConf.toFixed(3)}`,
          `Domains: ${
            Array.from(domains.entries())
              .map(([k, v]) => `${k}(${v})`)
              .join(", ") || "none"
          }`,
        ].join("\n"),
      },
    ],
  };
}

export default plugin;
