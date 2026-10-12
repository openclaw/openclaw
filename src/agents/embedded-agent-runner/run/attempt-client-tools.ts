import { getAgentToolAssistantTurnId } from "../../../../packages/agent-core/src/tool-execution-context.js";
import {
  getPluginToolMeta,
  getPluginToolSideEffectOwnerKey,
} from "../../../plugins/tool-metadata.js";
import {
  createClientToolNameConflictError,
  findClientToolNameConflicts,
  toClientToolDefinitions,
  toToolDefinitions,
} from "../../agent-tool-definition-adapter.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import { resolveToolLoopDetectionConfig } from "../../agent-tools.js";
import { isCodeModeExecTool } from "../../code-mode-control-tools.js";
import { isCoreToolResultMediaTrustedName } from "../../embedded-agent-tool-media.js";
import type { AgentTool } from "../../runtime/index.js";
import {
  createToolDefinitionFromAgentTool,
  wrapToolDefinition,
} from "../../sessions/tools/tool-definition-wrapper.js";
import { normalizeToolPolicyName } from "../../tool-policy-shared.js";
import {
  collectReplaySafeToolNames,
  collectSideEffectToolOwners,
  isAgentToolReplaySafe,
} from "../../tool-replay-safety.js";
import { addClientToolsToToolCatalog } from "../../tool-search-catalog.js";
import { resolveToolSearchConfig, type ToolSearchCatalogRef } from "../../tool-search.js";
import { log } from "../logger.js";
import {
  AGENT_RESERVED_TOOL_NAMES,
  collectRegisteredToolNames,
  toSessionToolAllowlist,
} from "../tool-name-allowlist.js";
import type { EmbeddedAttemptClientToolCallSlot, EmbeddedRunAttemptParams } from "./types.js";

export function prepareEmbeddedAttemptClientTools(params: {
  attempt: EmbeddedRunAttemptParams;
  catalogToolHookContext: Parameters<typeof toToolDefinitions>[1];
  codeModeControlsEnabledForRun: boolean;
  deferredDirectoryToolsCallable: boolean;
  effectiveTools: AgentTool[];
  replaySafetyOptions: Parameters<typeof isAgentToolReplaySafe>[1];
  sandboxSessionKey?: string;
  sessionAgentId: string;
  toolSearchCatalogRef?: ToolSearchCatalogRef;
  toolSearchRuntimeConfig: EmbeddedRunAttemptParams["config"];
  uncompactedEffectiveTools: AgentTool[];
  clientTools: EmbeddedRunAttemptParams["clientTools"];
  getToolAbortSignal?: () => AbortSignal;
}) {
  // Reserve synchronously so parallel client-tool batches preserve assistant source order.
  const clientToolCallSlots: EmbeddedAttemptClientToolCallSlot[] = [];
  const clientToolCallSlotsById = new Map<string, EmbeddedAttemptClientToolCallSlot>();
  // Provider call ids repeat across assistant responses; slots are per issuing response.
  const clientToolCallSlotKey = (toolCallId: string) =>
    `${getAgentToolAssistantTurnId() ?? ""}\u0000${toolCallId}`;
  const reserveClientToolCallSlot = (toolCallId: string, toolName: string) => {
    const slotKey = clientToolCallSlotKey(toolCallId);
    let slot = clientToolCallSlotsById.get(slotKey);
    if (!slot) {
      slot = { toolCallId, name: toolName, completed: false };
      clientToolCallSlotsById.set(slotKey, slot);
      clientToolCallSlots.push(slot);
    }
    return slot;
  };
  const clientToolLoopDetection = resolveToolLoopDetectionConfig({
    cfg: params.attempt.config,
    agentId: params.sessionAgentId,
  });
  const sourceClientToolDefs = params.clientTools
    ? toClientToolDefinitions(
        params.clientTools,
        {
          reserve: reserveClientToolCallSlot,
          complete: (toolCallId, toolName, toolParams) => {
            const slot = reserveClientToolCallSlot(toolCallId, toolName);
            slot.name = toolName;
            slot.params = toolParams;
            slot.completed = true;
          },
          discard: (toolCallId) => {
            const slot = clientToolCallSlotsById.get(clientToolCallSlotKey(toolCallId));
            if (slot) {
              slot.completed = false;
              slot.params = undefined;
            }
          },
        },
        {
          agentId: params.sessionAgentId,
          sessionKey: params.sandboxSessionKey,
          config: params.toolSearchRuntimeConfig,
          sessionId: params.attempt.sessionId,
          runId: params.attempt.runId,
          loopDetection: clientToolLoopDetection,
          onToolOutcome: params.attempt.onToolOutcome,
          allocateToolOutcomeOrdinal: params.attempt.allocateToolOutcomeOrdinal,
        },
      )
    : [];
  const buildSurface = () => {
    // Raw names gate trusted local media passthrough; normalized aliases are insufficient.
    const builtinToolNames = new Set<string>();
    const trustedLocalMediaToolNames = new Set<string>();
    for (const tool of params.uncompactedEffectiveTools) {
      const name = (tool.name ?? "").trim();
      if (!name) {
        continue;
      }
      builtinToolNames.add(name);
      const pluginMeta = getPluginToolMeta(tool);
      if (
        pluginMeta?.trustedLocalMedia === true ||
        (!pluginMeta && isCoreToolResultMediaTrustedName(name))
      ) {
        trustedLocalMediaToolNames.add(name);
      }
    }
    const coreBuiltinToolNames = collectRegisteredToolNames(
      params.uncompactedEffectiveTools.filter((tool) => !getPluginToolMeta(tool)),
    );
    const isReplaySafeTool = (tool: { name?: string }) =>
      isAgentToolReplaySafe(tool, params.replaySafetyOptions);
    const replaySafeTools = new Set(params.uncompactedEffectiveTools.filter(isReplaySafeTool));
    const replaySafeToolNames = collectReplaySafeToolNames(
      params.uncompactedEffectiveTools,
      params.replaySafetyOptions,
    );
    // Only the marked Code Mode exec owns a resumable run; a plain shell exec of
    // the same name must never be mistaken for one at tool completion. The marked
    // controls exist only on the post-catalog `effectiveTools` surface.
    const codeModeExecToolNames = new Set(
      params.effectiveTools.filter((tool) => isCodeModeExecTool(tool)).map((tool) => tool.name),
    );
    // Only a tool author can opt a tool into delivering its result as the source reply.
    // Names are policy-normalized because completion and terminal hooks compare them so.
    const sourceReplyCapableToolNames = new Set(
      params.uncompactedEffectiveTools
        .filter((tool) => "canDeliverSourceReply" in tool && tool.canDeliverSourceReply === true)
        .map((tool) => normalizeToolPolicyName(tool.name ?? ""))
        .filter((name) => name.length > 0),
    );
    const clientConflictToolNames = params.deferredDirectoryToolsCallable
      ? builtinToolNames
      : coreBuiltinToolNames;
    const clientToolNameConflicts = findClientToolNameConflicts({
      tools: params.clientTools ?? [],
      existingToolNames: [...clientConflictToolNames, ...AGENT_RESERVED_TOOL_NAMES],
    });
    if (clientToolNameConflicts.length > 0) {
      throw createClientToolNameConflictError(clientToolNameConflicts);
    }

    let clientToolDefs = sourceClientToolDefs.map((definition) =>
      createToolDefinitionFromAgentTool(
        wrapToolWithAbortSignal(wrapToolDefinition(definition), params.getToolAbortSignal?.()),
      ),
    );
    // Terminal observations are name-only, so ownership is valid only when one
    // concrete OpenClaw or client tool owns the normalized name.
    const sideEffectToolOwners = collectSideEffectToolOwners(
      [...params.uncompactedEffectiveTools, ...clientToolDefs],
      {
        declaredOwner: (tool) =>
          getPluginToolSideEffectOwnerKey(
            tool as Parameters<typeof getPluginToolSideEffectOwnerKey>[0],
          ),
      },
    );
    const search = resolveToolSearchConfig(params.toolSearchRuntimeConfig);
    const clientToolSearch = addClientToolsToToolCatalog({
      tools: clientToolDefs,
      enabled:
        params.codeModeControlsEnabledForRun || (search.enabled && search.mode !== "directory"),
      catalogRef: params.toolSearchCatalogRef,
    });
    clientToolDefs = clientToolSearch.tools;
    if (clientToolSearch.compacted) {
      log.info(
        params.codeModeControlsEnabledForRun
          ? `code-mode: cataloged ${clientToolSearch.catalogToolCount} client tools behind exec/wait`
          : `tool-search: cataloged ${clientToolSearch.catalogToolCount} client tools behind compact prompt surface`,
      );
    }

    const customTools = toToolDefinitions(
      params.effectiveTools,
      params.catalogToolHookContext,
      params.getToolAbortSignal?.(),
    );
    const allCustomTools = [...customTools, ...clientToolDefs];
    const sessionToolAllowlist = toSessionToolAllowlist(collectRegisteredToolNames(allCustomTools));
    return {
      allCustomTools,
      builtinToolNames,
      coreBuiltinToolNames,
      clientToolCallSlots,
      clientToolDefs,
      replaySafeToolNames,
      replaySafeTools,
      codeModeExecToolNames,
      sourceReplyCapableToolNames,
      sideEffectToolOwners,
      sessionToolAllowlist,
      trustedLocalMediaToolNames,
    };
  };
  const current = buildSurface();
  return {
    ...current,
    refreshTools: () => {
      const next = buildSurface();
      const replaceItems = <T>(target: T[], source: T[]) =>
        target.splice(0, target.length, ...source);
      replaceItems(current.allCustomTools, next.allCustomTools);
      replaceItems(current.clientToolDefs, next.clientToolDefs);
      replaceItems(current.sessionToolAllowlist, next.sessionToolAllowlist);
      const replaceSet = <T>(target: Set<T>, source: Set<T>) => {
        target.clear();
        for (const item of source) {
          target.add(item);
        }
      };
      for (const key of [
        "builtinToolNames",
        "coreBuiltinToolNames",
        "replaySafeToolNames",
        "codeModeExecToolNames",
        "sourceReplyCapableToolNames",
        "trustedLocalMediaToolNames",
      ] as const) {
        replaceSet(current[key], next[key]);
      }
      replaceSet(current.replaySafeTools, next.replaySafeTools);
      current.sideEffectToolOwners.clear();
      for (const [name, owner] of next.sideEffectToolOwners) {
        current.sideEffectToolOwners.set(name, owner);
      }
    },
  };
}
