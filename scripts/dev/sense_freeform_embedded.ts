import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentConfig } from "../../src/agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../../src/agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../src/agents/pi-embedded-runner/run.js";
import { loadConfig } from "../../src/config/io.js";

type Args = {
  agentId: string;
  input: string;
  provider?: string;
  model?: string;
  senseBaseUrl?: string;
  timeoutMs: number;
  keepSessionFile: boolean;
  forceAlsoAllow: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    agentId: "ops",
    input: "",
    timeoutMs: 90_000,
    keepSessionFile: false,
    forceAlsoAllow: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent" && argv[i + 1]) {
      args.agentId = argv[++i]!;
      continue;
    }
    if (arg === "--input" && argv[i + 1]) {
      args.input = argv[++i]!;
      continue;
    }
    if (arg === "--provider" && argv[i + 1]) {
      args.provider = argv[++i]!;
      continue;
    }
    if (arg === "--model" && argv[i + 1]) {
      args.model = argv[++i]!;
      continue;
    }
    if (arg === "--sense-base-url" && argv[i + 1]) {
      args.senseBaseUrl = argv[++i]!;
      continue;
    }
    if (arg === "--timeout-ms" && argv[i + 1]) {
      args.timeoutMs = Number(argv[++i]) || args.timeoutMs;
      continue;
    }
    if (arg === "--keep-session-file") {
      args.keepSessionFile = true;
      continue;
    }
    if (arg === "--force-also-allow") {
      args.forceAlsoAllow = true;
      continue;
    }
  }
  if (!args.input.trim()) {
    throw new Error('Pass --input "..."');
  }
  return args;
}

function cloneConfigWithOverrides(params: {
  baseUrl?: string;
  agentId: string;
  forceAlsoAllow: boolean;
}) {
  const cfg = loadConfig();
  if (!params.baseUrl && !params.forceAlsoAllow) {
    return cfg;
  }
  const next = {
    ...cfg,
    agents: cfg.agents
      ? {
          ...cfg.agents,
          list: [...(cfg.agents.list ?? [])],
        }
      : undefined,
    plugins: cfg.plugins
      ? {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins.entries,
          },
        }
      : undefined,
  };
  if (params.forceAlsoAllow && next.agents?.list) {
    const agent = next.agents.list.find((entry) => entry.id === params.agentId);
    if (agent) {
      const currentTools = agent.tools ?? {};
      const additive = [
        "group:sessions",
        "group:automation",
        "nas_list",
        "nas_search",
        "nas_read",
        "nas_summary",
        "sense-worker",
      ];
      agent.tools = {
        ...currentTools,
        alsoAllow: Array.from(new Set([...(currentTools.alsoAllow ?? []), ...additive])),
      };
    }
  }
  if (params.baseUrl && next.plugins) {
    const existingConfig = cfg.plugins?.entries?.["sense-worker"]?.config;
    next.plugins.entries["sense-worker"] = {
      enabled: true,
      config: {
        ...existingConfig,
        baseUrl: params.baseUrl,
      },
    };
  }
  return next;
}

function extractTextPayloads(payloads: Array<{ text?: string }> | undefined): string[] {
  return (payloads ?? [])
    .map((payload) => payload.text?.trim())
    .filter((value): value is string => Boolean(value));
}

async function extractTranscriptHints(sessionFile: string) {
  const raw = await fs.readFile(sessionFile, "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const senseLines = lines.filter((line) => line.includes("sense-worker"));
  return {
    lineCount: lines.length,
    senseMentions: senseLines.length,
    transcriptExcerpt: senseLines.slice(-6),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = cloneConfigWithOverrides({
    baseUrl: args.senseBaseUrl,
    agentId: args.agentId,
    forceAlsoAllow: args.forceAlsoAllow,
  });
  const agentCfg = resolveAgentConfig(cfg, args.agentId);
  if (!agentCfg?.workspace || !agentCfg?.agentDir) {
    throw new Error(`Agent ${args.agentId} is missing workspace or agentDir`);
  }
  const resolvedModel = resolveDefaultModelForAgent({ cfg, agentId: args.agentId });
  const provider = args.provider ?? resolvedModel.provider;
  const model = args.model ?? resolvedModel.model;
  const sessionId = randomUUID();
  const sessionKey = `agent:${args.agentId}:sense-freeform-${Date.now().toString(36)}`;
  const sessionFile = path.join(os.tmpdir(), `openclaw-sense-freeform-${sessionId}.jsonl`);

  const prompt = [
    "Use the sense-worker tool with action=execute and task=summarize.",
    "Do not summarize locally unless the tool fails.",
    "Return a concise summary result.",
    "",
    args.input,
  ].join("\n");

  try {
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      agentId: args.agentId,
      sessionFile,
      workspaceDir: agentCfg.workspace,
      agentDir: agentCfg.agentDir,
      config: cfg,
      prompt,
      provider,
      model,
      timeoutMs: args.timeoutMs,
      runId: `sense-freeform-${Date.now().toString(36)}`,
    });

    const transcript = await extractTranscriptHints(sessionFile);
    const reportTools =
      result.meta.systemPromptReport?.tools.entries.map((entry) => entry.name) ?? [];
    const textPayloads = extractTextPayloads(result.payloads);
    const usedSenseWorker =
      reportTools.includes("sense-worker") ||
      transcript.senseMentions > 0 ||
      textPayloads.some((text) => text.includes("Sense summary:"));

    console.log(
      JSON.stringify(
        {
          ok: true,
          sessionId,
          sessionKey,
          sessionFile,
          provider,
          model,
          reportTools,
          usedSenseWorker,
          payloads: textPayloads,
          transcript,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!args.keepSessionFile) {
      await fs.rm(sessionFile, { force: true });
    }
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
