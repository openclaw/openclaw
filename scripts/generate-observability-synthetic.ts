#!/usr/bin/env node
import path from "node:path";
import {
  buildSyntheticObservabilityDataset,
  writeSyntheticObservabilityFiles,
} from "../src/observability/synthetic-data.js";

type CliArgs = {
  outDir: string;
  channels: string[];
  messagesPerChannel: number;
  agentId: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "true");
      continue;
    }
    args.set(key, next);
    index += 1;
  }

  const outDir = path.resolve(args.get("out") ?? ".tmp/observability-synthetic");
  const channels = (args.get("channels") ?? "discord,slack,telegram")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const messagesPerChannel = Number.parseInt(args.get("messages-per-channel") ?? "3", 10);
  const agentId = args.get("agent-id") ?? "agent-synthetic";
  return { outDir, channels, messagesPerChannel, agentId };
}

export async function generateSyntheticObservabilityFixture(
  argv: string[] = process.argv.slice(2),
) {
  const args = parseArgs(argv);
  const dataset = buildSyntheticObservabilityDataset({
    channels: args.channels,
    messagesPerChannel: args.messagesPerChannel,
    agentId: args.agentId,
  });

  const paths = await writeSyntheticObservabilityFiles({
    rootDir: args.outDir,
    agentId: args.agentId,
    dataset,
    systemFileName: "openclaw-generated.log",
  });

  return {
    outDir: args.outDir,
    ...paths,
  };
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  const output = await generateSyntheticObservabilityFixture();
  const rendered = {
    outDir: output.outDir,
    sessionFile: output.sessionFile,
    cacheTraceFile: output.cacheTraceFile,
    systemLogFile: output.systemLogFile,
    eventsPerSource: {
      session: output.dataset.sessionLines.length,
      "cache-trace": output.dataset.cacheTraceLines.length,
      "system-log": output.dataset.systemLogLines.length,
    },
  };
  process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
}
