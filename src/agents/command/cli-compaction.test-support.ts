import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createModelGenerationFixture } from "../embedded-agent-runner/model.generation-scope.test-support.js";

export function buildContextEngine(params: {
  compactCalls: Array<Parameters<ContextEngine["compact"]>[0]>;
}): ContextEngine {
  return {
    info: {
      id: "legacy",
      name: "Legacy Context Engine",
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(assembleParams) {
      return { messages: assembleParams.messages, estimatedTokens: 0 };
    },
    async compact(compactParams) {
      params.compactCalls.push(compactParams);
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          tokensBefore: compactParams.currentTokenCount ?? 0,
          tokensAfter: 100,
        },
      };
    },
  };
}

export function createPreparedRuntimeLease(input: {
  config: OpenClawConfig;
  agentDir: string;
  agentId?: string;
  workspaceDir?: string;
}) {
  const prepared = createModelGenerationFixture({
    config: input.config,
    label: "cli",
    agentDir: input.agentDir,
    workspaceDir: expectDefined(input.workspaceDir, "compaction fixture workspace"),
  });
  return {
    snapshot: {
      ...prepared.preparedModelRuntime,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
    pluginGeneration: {
      remoteCatalog: null,
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: prepared.metadataSnapshot,
      pluginRegistry: prepared.pluginRegistry,
    },
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}
