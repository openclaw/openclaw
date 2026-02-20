import { Type } from "@sinclair/typebox";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "../../src/plugins/types.js";
import { createSoundChainApi, type SoundChainApi, type SoundChainConfig } from "./src/api.js";
import {
  runPipeline,
  quickDiagnose,
  deepDiagnose,
  PIPELINE_STAGES,
  classifyError,
} from "./src/phil-jackson.js";
import {
  createWarRoomClient,
  type WarRoomClient,
  type WarRoomConfig,
  OLLAMA_MODELS,
  FLEET_NODES,
  SPECIALISTS,
} from "./src/warroom.js";

function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// ---------------------------------------------------------------------------
// Music Tools (SoundChain Agent REST API)
// ---------------------------------------------------------------------------

function createSearchTool(api: SoundChainApi): AnyAgentTool {
  return {
    name: "soundchain_search",
    label: "SoundChain Search",
    description:
      "Search for music tracks on SoundChain by title, artist, or album. Returns track info including stream URLs, play counts, and SCID codes for streaming rewards.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query (title, artist, or album). Minimum 2 characters.",
      }),
      limit: Type.Optional(
        Type.Number({ description: "Max results to return (1-50, default 10)." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query || query.length < 2) {
        return json({ error: "Search query must be at least 2 characters." });
      }
      const limit = typeof params.limit === "number" ? Math.min(Math.max(params.limit, 1), 50) : 10;
      return json(await api.searchTracks(query, limit));
    },
  } as AnyAgentTool;
}

function createRadioTool(api: SoundChainApi): AnyAgentTool {
  return {
    name: "soundchain_radio",
    label: "OGUN Radio",
    description:
      "Get the currently playing track on OGUN Radio — a decentralized NFT radio station rotating 600+ tracks. Returns now-playing info, stream URL, SCID for rewards, and available genres.",
    parameters: Type.Object({}),
    async execute() {
      return json(await api.getRadio());
    },
  } as AnyAgentTool;
}

function createPlayTool(api: SoundChainApi): AnyAgentTool {
  return {
    name: "soundchain_play",
    label: "SoundChain Play",
    description:
      "Report a track play on SoundChain and trigger OGUN streaming rewards. Both the creator (70%) and listener (30%) earn OGUN tokens. Include the SCID code to activate rewards.",
    parameters: Type.Object({
      track_id: Type.String({ description: "Track ID from search or radio results." }),
      track_title: Type.String({ description: "Track title for display." }),
      scid: Type.Optional(
        Type.String({
          description: "SCID code (e.g. SC-POL-XXXX-XXXXXXX) to trigger OGUN rewards.",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const trackId = typeof params.track_id === "string" ? params.track_id.trim() : "";
      const trackTitle = typeof params.track_title === "string" ? params.track_title.trim() : "";
      if (!trackId) return json({ error: "track_id is required." });
      if (!trackTitle) return json({ error: "track_title is required." });
      const scid = typeof params.scid === "string" ? params.scid.trim() : undefined;
      return json(await api.reportPlay(trackId, trackTitle, scid));
    },
  } as AnyAgentTool;
}

function createStatsTool(api: SoundChainApi): AnyAgentTool {
  return {
    name: "soundchain_stats",
    label: "SoundChain Stats",
    description:
      "Get SoundChain platform statistics: total tracks, IPFS-backed audio/artwork counts, NFT counts, and estimated totals.",
    parameters: Type.Object({}),
    async execute() {
      return json(await api.getPlatformStats());
    },
  } as AnyAgentTool;
}

function createTrendingTool(api: SoundChainApi): AnyAgentTool {
  return {
    name: "soundchain_trending",
    label: "SoundChain Trending",
    description:
      "Get trending content on SoundChain: hot tracks by play count, trending stories/reels, and rising artists by follower count.",
    parameters: Type.Object({}),
    async execute() {
      return json(await api.getTrending());
    },
  } as AnyAgentTool;
}

function createDiscoverTool(api: SoundChainApi): AnyAgentTool {
  return {
    name: "soundchain_discover",
    label: "SoundChain Discover",
    description:
      "Discover random tracks, posts, and artists on SoundChain. Returns a shuffled mix of content for serendipitous exploration — great for finding new music.",
    parameters: Type.Object({}),
    async execute() {
      return json(await api.getDiscover());
    },
  } as AnyAgentTool;
}

function createLeaderboardTool(api: SoundChainApi): AnyAgentTool {
  return {
    name: "soundchain_leaderboard",
    label: "SoundChain Leaderboard",
    description:
      "View the SoundChain agent leaderboard: top agents ranked by plays, comments, SCID mints, and OGUN earned. Shows whitelist status and airdrop eligibility.",
    parameters: Type.Object({}),
    async execute() {
      return json(await api.getLeaderboard());
    },
  } as AnyAgentTool;
}

// ---------------------------------------------------------------------------
// War Room — Infrastructure Tools
// ---------------------------------------------------------------------------

function createWarRoomHealthTool(wr: WarRoomClient): AnyAgentTool {
  return {
    name: "warroom_health",
    label: "War Room Health",
    description:
      "Check the health of the entire War Room: SCid Worker (task router), Ollama (7 local LLM models), fleet nodes (mini/grater/rog), and specialist agent domains. Returns status of all systems.",
    parameters: Type.Object({}),
    async execute() {
      return json(await wr.fleetHealth());
    },
  } as AnyAgentTool;
}

function createOllamaDirectTool(wr: WarRoomClient): AnyAgentTool {
  return {
    name: "warroom_ollama",
    label: "War Room Ollama",
    description:
      "Send a prompt directly to any Ollama model. Available: mistral (fast), qwen:7b (code), llama3.1 (reason), falcon:7b (syntax), gemma:7b (deps), mixtral:8x22b (architect, 79GB), jmorgan/grok (deep, 116GB). Zero token cost — all local.",
    parameters: Type.Object({
      model: Type.String({
        description: "Model name (e.g. 'mistral:latest', 'mixtral:8x22b', 'jmorgan/grok:latest').",
      }),
      prompt: Type.String({ description: "The prompt to send to the model." }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const model = typeof params.model === "string" ? params.model.trim() : "";
      const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
      if (!model) return json({ error: "model is required." });
      if (!prompt) return json({ error: "prompt is required." });
      return json(await wr.ollamaGenerate(model, prompt));
    },
  } as AnyAgentTool;
}

function createWarRoomTaskTool(wr: WarRoomClient): AnyAgentTool {
  return {
    name: "warroom_task",
    label: "War Room Task",
    description:
      "Send a raw task to the SCid Worker (localhost:8787). Task prefixes: 'think:', 'code:', 'reason:', 'bash:', 'read:', 'grep:', 'glob:', 'git:status', 'build', 'ping'.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "Task string. Examples: 'bash:ls -la', 'read:src/index.ts', 'grep:TODO:src/', 'build', 'git:status'.",
      }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!task) return json({ error: "task is required." });
      return json(await wr.scidTask(task));
    },
  } as AnyAgentTool;
}

// ---------------------------------------------------------------------------
// Phil Jackson Triangle — Diagnostic Pipeline Tools
// ---------------------------------------------------------------------------

function createDiagnoseTool(wr: WarRoomClient): AnyAgentTool {
  return {
    name: "warroom_diagnose",
    label: "Phil Jackson Diagnose",
    description:
      "Run the Phil Jackson Triangle Pipeline on a problem. Routes through up to 7 Ollama models in sequence — each with a specific role (syntax, deep analysis, fast fix, deps, architect, captain, backup). Auto-classifies the error type and starts with the most relevant model. Use depth='quick' for 1 model, 'standard' for 3, 'deep' for all 7.",
    parameters: Type.Object({
      problem: Type.String({
        description:
          "The error message, build failure, bug description, or code problem to diagnose.",
      }),
      depth: Type.Optional(
        Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")], {
          description:
            "Pipeline depth: 'quick' = 1 model (fast break), 'standard' = 3 models (half-court), 'deep' = all 7 (full triangle rotation). Default: 'standard'.",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const problem = typeof params.problem === "string" ? params.problem.trim() : "";
      if (!problem) return json({ error: "problem is required." });

      const depth = typeof params.depth === "string" ? params.depth : "standard";
      let result;
      switch (depth) {
        case "quick":
          result = await quickDiagnose(wr, problem);
          break;
        case "deep":
          result = await deepDiagnose(wr, problem);
          break;
        default:
          result = await runPipeline(wr, problem, 3);
          break;
      }
      return json(result);
    },
  } as AnyAgentTool;
}

function createSpecialistTool(wr: WarRoomClient): AnyAgentTool {
  return {
    name: "warroom_specialist",
    label: "War Room Specialist",
    description: `Route a problem to a SoundChain specialist domain. Available specialists:
- code-simplifier: Cleanup, refactoring, duplicate consolidation
- dex-inspector: DEX swap flow, marketplace tx, OGUN swap, auction, staking
- helix-validator: MongoDB <-> Blockchain sync, ownership mismatch, balance desync, SCid
- ipfs-auditor: IPFS/Pinata streaming, CID missing, gateway timeout, artwork
- mobile-detective: iOS/Android bugs, Safari, wallet deep links, in-app browser
- verify-app: E2E testing, pre-merge checks, regression tests
- wallet-debugger: Wallet connection, balance shows 0, session lost, chain switch`,
    parameters: Type.Object({
      specialist: Type.String({
        description:
          "Specialist domain: 'code-simplifier', 'dex-inspector', 'helix-validator', 'ipfs-auditor', 'mobile-detective', 'verify-app', or 'wallet-debugger'.",
      }),
      problem: Type.String({
        description: "Describe the issue for the specialist to investigate.",
      }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const specialist = typeof params.specialist === "string" ? params.specialist.trim() : "";
      const problem = typeof params.problem === "string" ? params.problem.trim() : "";
      if (!specialist) return json({ error: "specialist is required." });
      if (!problem) return json({ error: "problem is required." });

      const spec = SPECIALISTS[specialist as keyof typeof SPECIALISTS];
      if (!spec) {
        return json({
          error: `Unknown specialist '${specialist}'. Available: ${Object.keys(SPECIALISTS).join(", ")}`,
        });
      }

      // Route to the best model for this specialist's domain
      const modelMap: Record<string, string> = {
        "code-simplifier": "qwen:7b",
        "dex-inspector": "llama3.1:latest",
        "helix-validator": "jmorgan/grok:latest",
        "ipfs-auditor": "mistral:latest",
        "mobile-detective": "gemma:7b",
        "verify-app": "mistral:latest",
        "wallet-debugger": "llama3.1:latest",
      };

      const model = modelMap[specialist] ?? "mistral:latest";

      const prompt = `You are the ${specialist} specialist for SoundChain.
Your focus: ${spec.focus}
Known triggers: ${spec.triggers.join(", ")}

PROBLEM:
${problem}

Analyze this issue within your domain. Be specific: file paths, line numbers, code fixes, commands to run. No fluff.`;

      const response = await wr.ollamaGenerate(model, prompt);
      return json({
        specialist,
        focus: spec.focus,
        model,
        response,
      });
    },
  } as AnyAgentTool;
}

function createPipelineInfoTool(): AnyAgentTool {
  return {
    name: "warroom_roster",
    label: "War Room Roster",
    description:
      "View the Phil Jackson Triangle Pipeline roster — all 7 models, their roles, triggers, tasks, and NBA chemistry analogies. Also shows fleet nodes and specialist domains.",
    parameters: Type.Object({}),
    async execute() {
      return json({
        pipeline: PIPELINE_STAGES.map((s) => ({
          stage: s.name,
          model: s.model,
          role: s.role,
          trigger: s.trigger,
          tasks: s.tasks,
          chemistry: s.chemistry,
        })),
        models: OLLAMA_MODELS,
        fleet: FLEET_NODES,
        specialists: SPECIALISTS,
      });
    },
  } as AnyAgentTool;
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

const plugin = {
  id: "soundchain",
  name: "SoundChain",
  description:
    "SoundChain War Room — Phil Jackson Triangle diagnostic pipeline (7 Ollama models), specialist agents, fleet nodes, music API + OGUN streaming rewards. Build. Diagnose. Ship.",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

    // Music API config
    const scConfig: SoundChainConfig = {
      apiUrl: typeof cfg.apiUrl === "string" && cfg.apiUrl ? cfg.apiUrl : "https://soundchain.io",
      agentName:
        typeof cfg.agentName === "string" && cfg.agentName ? cfg.agentName : "openclaw-agent",
      agentWallet:
        typeof cfg.agentWallet === "string" && cfg.agentWallet ? cfg.agentWallet : undefined,
    };

    // War Room config
    const wrConfig: WarRoomConfig = {
      scidWorkerUrl:
        typeof cfg.scidWorkerUrl === "string" && cfg.scidWorkerUrl
          ? cfg.scidWorkerUrl
          : "http://localhost:8787",
      ollamaUrl:
        typeof cfg.ollamaUrl === "string" && cfg.ollamaUrl
          ? cfg.ollamaUrl
          : "http://localhost:11434",
    };

    const scApi = createSoundChainApi(scConfig);
    const wrClient = createWarRoomClient(wrConfig);

    // --- Music tools (SoundChain Agent REST API) ---
    const musicTools = [
      createSearchTool,
      createRadioTool,
      createPlayTool,
      createStatsTool,
      createTrendingTool,
      createDiscoverTool,
      createLeaderboardTool,
    ];

    for (const createTool of musicTools) {
      api.registerTool(
        ((ctx) => {
          if (ctx.sandboxed) return null;
          return createTool(scApi);
        }) as OpenClawPluginToolFactory,
        { optional: true },
      );
    }

    // --- War Room infrastructure tools ---
    const infrastructureTools = [
      createWarRoomHealthTool,
      createOllamaDirectTool,
      createWarRoomTaskTool,
    ];

    for (const createTool of infrastructureTools) {
      api.registerTool(
        ((ctx) => {
          if (ctx.sandboxed) return null;
          return createTool(wrClient);
        }) as OpenClawPluginToolFactory,
        { optional: true },
      );
    }

    // --- Phil Jackson Triangle diagnostic tools ---
    const diagnosticTools = [createDiagnoseTool, createSpecialistTool];

    for (const createTool of diagnosticTools) {
      api.registerTool(
        ((ctx) => {
          if (ctx.sandboxed) return null;
          return createTool(wrClient);
        }) as OpenClawPluginToolFactory,
        { optional: true },
      );
    }

    // --- Roster (no client needed) ---
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) return null;
        return createPipelineInfoTool();
      }) as OpenClawPluginToolFactory,
      { optional: true },
    );
  },
};

export default plugin;
