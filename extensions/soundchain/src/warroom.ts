/**
 * War Room Client — SCid Worker + Ollama + Fleet Dispatch
 *
 * Bridges OpenClaw to the SoundChain War Room:
 *   - SCid Worker (localhost:8787) — task router for bash/think/code/reason
 *   - Ollama (localhost:11434) — 7 local LLM models, zero tokens
 *   - Fleet nodes (mini/grater/rog) — distributed compute via SSH
 *
 * Phil Jackson Pipeline (7 models):
 *   1. falcon:7b      — Syntax Specialist (Steph Curry's shooting)
 *   2. jmorgan/grok   — Deep Analyst (LeBron: sees the whole court)
 *   3. mistral:latest — First Responder (Curry: fast handles)
 *   4. gemma:7b       — Dependency Coordinator (Draymond: organizes)
 *   5. mixtral:8x22b  — Architect (Durant: long-range vision)
 *   6. llama3.1       — Team Captain (Jordan: closes with dominance)
 *   7. qwen:7b        — Backup (Iguodala: steps up when needed)
 */

export interface WarRoomConfig {
  scidWorkerUrl: string;
  ollamaUrl: string;
}

// Ollama model roster — Phil Jackson's starting five + bench
export const OLLAMA_MODELS: Record<string, { model: string; role: string; description: string }> = {
  fast: {
    model: "mistral:latest",
    role: "First Responder",
    description: "Quick queries, scan logs, instant patches (4.4GB)",
  },
  code: {
    model: "qwen:7b",
    role: "Code Specialist",
    description: "Code understanding, syntax analysis (4.5GB)",
  },
  reason: {
    model: "llama3.1:latest",
    role: "Team Captain",
    description: "Complex reasoning, review consistency (4.9GB)",
  },
  syntax: {
    model: "falcon:7b",
    role: "Syntax Specialist",
    description: "Detect and fix syntax errors, JSX/TSX validation (4.2GB)",
  },
  deps: {
    model: "gemma:7b",
    role: "Dependency Coordinator",
    description: "Validate dependency versions, package.json analysis (5.0GB)",
  },
  architect: {
    model: "mixtral:8x22b",
    role: "Architect",
    description: "Project-wide implications, strategic planning (79GB)",
  },
  deep: {
    model: "jmorgan/grok:latest",
    role: "Deep Analyst",
    description: "Deep analysis, type system validation (116GB)",
  },
};

// War Room fleet nodes
export const FLEET_NODES = {
  mini: { ip: "192.168.1.22", role: "Headless test runner, CI/CD" },
  grater: { ip: "192.168.1.23", role: "Log streaming, monitoring" },
  rog: { ip: "192.168.1.29", role: "Windows testing, 16TB storage, GPU compute" },
} as const;

// 7 Specialist subagent domains (from archived Claude agents)
export const SPECIALISTS = {
  "code-simplifier": {
    focus: "Cleanup and refactoring after fixes",
    triggers: ["debug code removal", "duplicate consolidation", "unused export cleanup"],
  },
  "dex-inspector": {
    focus: "DEX swap flow debugging",
    triggers: ["marketplace transaction", "OGUN swap", "auction flow", "staking panel"],
  },
  "helix-validator": {
    focus: "MongoDB <-> Blockchain sync verification",
    triggers: ["ownership mismatch", "balance desync", "SCid registration", "reward accumulation"],
  },
  "ipfs-auditor": {
    focus: "IPFS/Pinata streaming issues",
    triggers: ["track won't load", "CID missing", "gateway timeout", "artwork not showing"],
  },
  "mobile-detective": {
    focus: "iOS/Android specific issues",
    triggers: ["safari bug", "mobile crash", "wallet deep link", "in-app browser"],
  },
  "verify-app": {
    focus: "E2E testing before PRs",
    triggers: ["pre-merge check", "regression test", "cross-platform verify"],
  },
  "wallet-debugger": {
    focus: "Wallet connection issues",
    triggers: ["metamask won't connect", "balance shows 0", "session lost", "chain switch"],
  },
} as const;

async function fetchJson(url: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return res.json();
}

export function createWarRoomClient(config: WarRoomConfig) {
  const scid = config.scidWorkerUrl.replace(/\/+$/, "");
  const ollama = config.ollamaUrl.replace(/\/+$/, "");

  return {
    // ---------------------------------------------------------------
    // SCid Worker tasks (localhost:8787)
    // ---------------------------------------------------------------

    /** Send any task to SCid Worker */
    async scidTask(task: string): Promise<unknown> {
      return fetchJson(`${scid}/task`, {
        method: "POST",
        body: JSON.stringify({ task }),
      });
    },

    /** Health check — returns status + available models */
    async scidHealth(): Promise<unknown> {
      return fetchJson(`${scid}/health`);
    },

    // ---------------------------------------------------------------
    // Ollama direct API (localhost:11434)
    // ---------------------------------------------------------------

    /** Generate completion from a specific Ollama model */
    async ollamaGenerate(model: string, prompt: string): Promise<unknown> {
      return fetchJson(`${ollama}/api/generate`, {
        method: "POST",
        body: JSON.stringify({ model, prompt, stream: false }),
      });
    },

    /** List all locally available Ollama models */
    async ollamaList(): Promise<unknown> {
      return fetchJson(`${ollama}/api/tags`);
    },

    // ---------------------------------------------------------------
    // Convenience wrappers matching SCid Worker task routing
    // ---------------------------------------------------------------

    /** Quick think (mistral) */
    async think(prompt: string): Promise<unknown> {
      return this.scidTask(`think:${prompt}`);
    },

    /** Code analysis (qwen) */
    async code(prompt: string): Promise<unknown> {
      return this.scidTask(`code:${prompt}`);
    },

    /** Complex reasoning (llama3.1) */
    async reason(prompt: string): Promise<unknown> {
      return this.scidTask(`reason:${prompt}`);
    },

    /** Run bash command on Fleet Commander */
    async bash(cmd: string): Promise<unknown> {
      return this.scidTask(`bash:${cmd}`);
    },

    /** Run yarn build */
    async build(): Promise<unknown> {
      return this.scidTask("build");
    },

    /** Git status */
    async gitStatus(): Promise<unknown> {
      return this.scidTask("git:status");
    },

    /** Read a file */
    async readFile(path: string): Promise<unknown> {
      return this.scidTask(`read:${path}`);
    },

    /** Grep search */
    async grep(pattern: string, path?: string): Promise<unknown> {
      return this.scidTask(path ? `grep:${pattern}:${path}` : `grep:${pattern}`);
    },

    /** Glob find files */
    async glob(pattern: string, path?: string): Promise<unknown> {
      return this.scidTask(path ? `glob:${pattern}:${path}` : `glob:${pattern}`);
    },

    /** Ping SCid Worker */
    async ping(): Promise<unknown> {
      return this.scidTask("ping");
    },

    // ---------------------------------------------------------------
    // War Room fleet health
    // ---------------------------------------------------------------

    /** Check all War Room nodes + SCid Worker + Ollama */
    async fleetHealth(): Promise<unknown> {
      const results: Record<string, unknown> = {
        fleet_commander: { status: "active", role: "Strategic command, Claude Code" },
      };

      // SCid Worker
      try {
        results.scid_worker = await this.scidHealth();
      } catch {
        results.scid_worker = { status: "offline", url: scid };
      }

      // Ollama
      try {
        const tags = (await this.ollamaList()) as { models?: unknown[] };
        results.ollama = {
          status: "online",
          models_loaded: Array.isArray(tags?.models) ? tags.models.length : 0,
          url: ollama,
        };
      } catch {
        results.ollama = { status: "offline", url: ollama };
      }

      // Fleet nodes (informational — SSH check would need subprocess)
      results.nodes = FLEET_NODES;

      // Specialist domains available
      results.specialists = Object.keys(SPECIALISTS);

      return results;
    },
  };
}

export type WarRoomClient = ReturnType<typeof createWarRoomClient>;
