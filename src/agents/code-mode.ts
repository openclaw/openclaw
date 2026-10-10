import { Type } from "typebox";
import { getAgentToolAssistantTurnId } from "../../packages/agent-core/src/tool-execution-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import { CODE_MODE_NODES_TOOL_ID, isCodeModeSwarmAvailable } from "./code-mode-bridge.js";
import { createCodeModeCatalogBindings, type CodeModeCatalogBinding } from "./code-mode-catalog.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeExecDescriptionUpdater,
  isCodeModeControlTool,
  markCodeModeControlTool,
} from "./code-mode-control-tools.js";
import {
  normalizeCodeModeTimeoutResult,
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
} from "./code-mode-errors.js";
import { runCodeModeExec, runWait } from "./code-mode-execution.js";
import { runCodeModeScriptHeadless } from "./code-mode-headless.js";
import { describeCodeModeNamespacesForPrompt } from "./code-mode-namespaces.js";
import { markCodeModePermissionChangeResult } from "./code-mode-permission-change.js";
import {
  isCodeModeEngagedForModel,
  readCode,
  readRunId,
  resolveCodeModeConfig,
} from "./code-mode-runtime.js";
import { recordCodeModeToolOutcome } from "./code-mode-tool-outcome.js";
import { isCoreCodingSurfaceToolName } from "./core-tool-factory-descriptors.js";
import { captureAgentPluginRuntimeRefresh } from "./plugin-runtime-refresh.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { executionTitleSchema } from "./schema/typebox.js";
import { isToolExecutionAllowed } from "./tool-policy-shared.js";
import { resolveToolResultBudget } from "./tool-result-limits.js";
import {
  applyToolCatalogCompaction,
  compactToolSearchCatalogEntry,
  isDirectVisibleCatalogTool,
} from "./tool-search-catalog.js";
import { formatToolSearchControlResult, type ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import type { AnyAgentTool } from "./tools/common.js";

export { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME };
export {
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
  isCodeModeEngagedForModel,
  runCodeModeScriptHeadless,
  resolveCodeModeConfig,
};
export type { CodeModeFailureCode, CodeModeHeadlessResult } from "./code-mode-runtime.js";

type CodeModeToolContext = ToolSearchToolContext & { modelContextWindowTokens?: number };

const MAX_CODE_MODE_CATALOG_INDEX_CHARS = 8_000;

const CODE_MODE_CATALOG_INDEX_HEADING = [
  "Enabled async tool globals (descriptions are intentionally deferred):",
  "Each line is `callableName input -> output`; `-> ?` means unknown output.",
].join("\n");

function codeModeCatalogIndexFooter(included: number, total: number): string {
  const omitted = total - included;
  return omitted > 0
    ? `${omitted} additional tools omitted from this prompt index. Use catalog.search(query); results are callable.`
    : "Call these globals directly; use catalog.search(query) when lookup is ambiguous.";
}

function renderCodeModeCatalogIndex(lines: readonly string[], total: number): string {
  return [
    CODE_MODE_CATALOG_INDEX_HEADING,
    ...lines,
    "",
    codeModeCatalogIndexFooter(lines.length, total),
  ].join("\n");
}

function formatCodeModeCatalogIndex(bindings: readonly CodeModeCatalogBinding[]): string {
  const priority = (entry: CodeModeCatalogBinding) =>
    entry.id === `openclaw:core:${entry.name}` && isCoreCodingSurfaceToolName(entry.name)
      ? 0
      : entry.output
        ? 1
        : 2;
  const lines = bindings
    // Keep the same core file/shell contracts visible as Tool Search, even without
    // declared outputs. Otherwise catalog growth hides their input argument names.
    .toSorted((a, b) => priority(a) - priority(b) || a.callableName.localeCompare(b.callableName))
    .map(
      (entry) => `- ${entry.callableName} ${entry.input ?? "unknown"} -> ${entry.output ?? "?"}`,
    );
  if (lines.length === 0) {
    return "";
  }
  const fullIndex = renderCodeModeCatalogIndex(lines, lines.length);
  if (fullIndex.length <= MAX_CODE_MODE_CATALOG_INDEX_CHARS) {
    return fullIndex;
  }

  // Skip oversized entries instead of letting one blank the remaining index.
  const included: string[] = [];
  let includedLineLength = 0;
  for (const line of lines) {
    const candidateLineLength = includedLineLength + 1 + line.length;
    const candidateLength =
      CODE_MODE_CATALOG_INDEX_HEADING.length +
      candidateLineLength +
      2 +
      codeModeCatalogIndexFooter(included.length + 1, lines.length).length;
    if (candidateLength <= MAX_CODE_MODE_CATALOG_INDEX_CHARS) {
      included.push(line);
      includedLineLength = candidateLineLength;
    }
  }
  return renderCodeModeCatalogIndex(included, lines.length);
}

function createCodeModeExecDescription(
  ctx: CodeModeToolContext,
  catalog?: readonly ToolSearchCatalogEntry[],
  config = resolveCodeModeConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId),
): string {
  const namespacePrompt = describeCodeModeNamespacesForPrompt(catalog);
  // Native tools have schema-derived declarations too; keep remote schemas deferred.
  const catalogKnown = catalog !== undefined;
  const hasMcp = catalog?.some((entry) => entry.source === "mcp") ?? false;
  const swarmEnabled = isCodeModeSwarmAvailable(ctx, catalog);
  const apiGuidance =
    !catalogKnown || (catalog?.length ?? 0) > 0 || swarmEnabled
      ? " Read types with `API.list(prefix?)` and `API.read(path)`; read returns `{ path, description, content, bytes }`, not a string. Use `.content` for declaration text. Native tools: `tools/`. Types are documentation; write plain JavaScript."
      : "";
  const mcpGuidance =
    !catalogKnown || hasMcp
      ? " MCP tools use the `MCP` namespace or callable `catalog.search` handles."
      : "";
  const swarmGuidance = swarmEnabled
    ? " Swarm globals `agents.run`, `phase`, and `log` are available; read `agents.d.ts` for types and orchestration idioms."
    : "";
  // Nodes ride the owner-only core tool; advertising the namespace to a run
  // whose catalog cannot resolve it turns the hint into hallucination bait.
  const hasNodes = catalog?.some((entry) => entry.id === CODE_MODE_NODES_TOOL_ID) ?? false;
  const nodesGuidance =
    !catalogKnown || hasNodes
      ? "\n- nodes: paired Gateway nodes; nodes.list(), (await nodes.get(id)).invoke(command, params)\n"
      : "";
  const hasSkillTool = (name: string) =>
    catalog?.some((entry) => entry.source === "openclaw" && entry.name === name) &&
    (!ctx.toolExecutionAllow || isToolExecutionAllowed(ctx.toolExecutionAllow, name));
  const skillsGuidance =
    (hasSkillTool("skills_search")
      ? " Installed skills: use `await skills.search(query, limit)` to find relevant skills. `await skills.list()` lists up to 20 entries; pass an offset for later pages."
      : "") +
    (hasSkillTool("skills_read")
      ? " Use `await skills.read(name)` for complete installed skill instructions. A known exact name can be read directly."
      : "");
  const { maxOutputBytes, timeoutMs } = config;
  // The catalog already reserves built-in namespace globals without constructing their runtimes.
  const bindings = catalog
    ? createCodeModeCatalogBindings(catalog.map((entry) => compactToolSearchCatalogEntry(entry)))
    : undefined;
  const catalogIndex = bindings ? formatCodeModeCatalogIndex(bindings) : "";
  // Only the effective core binding proves shell capability after client overrides.
  const shellTool = bindings?.find((entry) => entry.id === "openclaw:core:exec");
  const shellGuidance = shellTool
    ? ` Use the shell tool \`${shellTool.callableName}\` for heavier computation.`
    : "";
  return (
    `Run JavaScript in OpenClaw. Each \`exec\` runs in a fresh JavaScript context; variables, functions and imports never carry over between cells. Set \`title\` to a 3–7 word purpose. Guest work and inline tool waits share a ${timeoutMs} ms wall-clock budget per \`exec\`/\`wait\`; approvals pause it. Guest computation over this budget times out. awaitResults:true keeps needed results owned and pauses only off-VM tool waits; run/tool deadlines still apply. Other pending tools may return \`waiting\` for \`wait\`.` +
    shellGuidance +
    ` Enabled tools are async global functions. Await dependent calls in order; independent calls may run with Promise.all. Declared output fields may feed later calls in the same program; avoid extra inspection calls. Emit output with \`text(value)\` or \`json(value)\`. Return the final value, otherwise \`null\`. Oversized final objects/arrays may return \`value.reference\`. \`-> ?\` means unknown output: do not feed it into guessed field-dependent logic in the same program. Return it raw or \`await results.save(value)\`; use a later \`exec\` for dependent composition. Save returns \`{id,bytes,count,shape,preview,previewTruncated}\`: emit that descriptor directly; full JSON stays stored. Load/delete with \`results.load(id)\`/\`results.delete(id)\`. Saved results references expire when the current reply ends; never reuse reference ids from earlier turns; use \`store\` for data needed later. \`await store(key, value)\`/\`await load(key)\` keep small JSON values across cells and turns in this session (survive restarts); contract: \`API.read("results.d.ts")\`. For omitted tools, use \`catalog.search(query)\`; results are callable: \`const [tool] = await catalog.search("..."); return await tool({...});\`. Use handle \`describe()\` for schemas. \`setTimeout\` and \`clearTimeout\` work. \`TextEncoder\`/\`TextDecoder\` convert local text and bytes. Console log/info/warn/error/debug emit bounded text. Nested calls enforce normal tool policy and approvals. Tool failures are catchable; inspect possible effects before retrying. Nested results are intact or throw resource errors. Cell reply inbox: ${Math.min(config.memoryLimitBytes, config.maxSnapshotBytes)} bytes; consume replies or paginate if full. Output/value/errors share ${maxOutputBytes} bytes across waits. Other truncation reports original JSON prefixes/omitted bytes; rerun with narrower args. Output is incremental; changed cumulative summaries replace earlier ones. Node.js modules and \`require\`/\`import\` are NOT available; use tools for external actions.` +
    apiGuidance +
    mcpGuidance +
    swarmGuidance +
    nodesGuidance +
    skillsGuidance +
    " `code` is JavaScript, never a shell command; do not retry failed shell source." +
    (namespacePrompt ? `\n\n${namespacePrompt}` : "") +
    (catalogIndex ? `\n\n${catalogIndex}` : "")
  );
}

export function createCodeModeTools(ctx: CodeModeToolContext): AnyAgentTool[] {
  const runtimeRefresh = captureAgentPluginRuntimeRefresh();
  // The surface planner owns activation. Capture limits once so an admitted
  // control remains executable during model overrides and restart recovery.
  const config = resolveCodeModeConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId);
  const resultBudget = resolveToolResultBudget(ctx.modelContextWindowTokens);
  const formatResult = (
    rawResult: Awaited<ReturnType<typeof runCodeModeExec | typeof runWait>>,
    runtime: ToolSearchRuntime | undefined,
    signal?: AbortSignal,
  ) => {
    const result = normalizeCodeModeTimeoutResult(rawResult);
    markCodeModePermissionChangeResult(result, signal);
    return recordCodeModeToolOutcome(
      {
        ...formatToolSearchControlResult(result, runtime, {
          terminalBatchStatus: result.status,
          compact: true,
        }),
        ...(runtimeRefresh.isRequested() ? { terminate: runtimeRefresh.isPending() } : {}),
      },
      result,
    );
  };
  const execTool = markCodeModeControlTool({
    name: CODE_MODE_EXEC_TOOL_NAME,
    label: "exec",
    description: createCodeModeExecDescription(ctx, undefined, config),
    parameters: Type.Object({
      title: executionTitleSchema({ required: true }),
      // `command` stays runtime-only for hook compatibility. Requiring `code`
      // prevents schema-valid empty calls from constrained models.
      code: Type.String({
        description:
          "Required JavaScript; no TypeScript annotations, Python, shell, `require`, or `import`. Use `return value`; a trailing expression yields `null`.",
      }),
      awaitResults: Type.Optional(
        Type.Boolean({
          description:
            "Required task results: keep this call owned through event-driven tool waits, without model polling. Explicit background services stay detached. Guest budget and run/tool deadlines still apply.",
        }),
      ),
      restartSafe: Type.Optional(
        Type.Boolean({
          description:
            "Do not set on a new exec. Set true only when OpenClaw explicitly requests replay after a gateway restart; never for write, edit, exec, or any mutation. True rejects unmarked or namespace surfaces.",
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      runtimeRefresh.assertCurrent();
      // Context closure fences new calls; the supplied signal owns in-flight
      // cancellation so sessions_yield can still finish its initiating handoff.
      ctx.abortSignal?.throwIfAborted();
      const input = readCode(args);
      let runtime: ToolSearchRuntime | undefined;
      const result = await runCodeModeExec({
        toolCallId,
        ctx,
        config,
        resultBudget,
        code: input.code,
        assistantTurnId: getAgentToolAssistantTurnId(),
        restartSafe: ctx.forceRestartSafeTools === true || input.restartSafe,
        awaitResults: input.awaitResults,
        signal,
        onUpdate,
        onRuntime: (value) => {
          runtime = value;
        },
      });
      return formatResult(result, runtime, signal);
    },
  } as AnyAgentTool);
  const waitTool = markCodeModeControlTool({
    name: CODE_MODE_WAIT_TOOL_NAME,
    label: "wait",
    hideFromChannelProgress: true,
    description:
      'Resume only when the outer exec result has status "waiting", using its top-level runId. A completed exec may return a still-running tool operation inside value; manage that operation through its enabled tool in a new exec. Never pass a nested sessionId or process ID to wait.',
    parameters: Type.Object({
      runId: Type.String({
        description:
          'Top-level runId from an exec result with status "waiting", never a nested tool sessionId.',
      }),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      runtimeRefresh.assertActive();
      ctx.abortSignal?.throwIfAborted();
      let runtime: ToolSearchRuntime | undefined;
      const result = await runWait({
        toolCallId,
        ctx,
        runId: readRunId(args),
        signal,
        onUpdate,
        onRuntime: (value) => {
          runtime = value;
        },
      });
      return formatResult(result, runtime, signal);
    },
  } as AnyAgentTool);
  return [execTool, waitTool];
}

/** Compact normal tools behind Code Mode exec/wait controls. */
export function applyCodeModeCatalog(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  agentId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
  toolExecutionAllow?: ToolSearchToolContext["toolExecutionAllow"];
  directToolNames?: Iterable<string>;
  codeModeSkills?: CodeModeToolContext["codeModeSkills"];
}) {
  const tools = finalizeAgentToolAvailability(params.tools, {
    toolExecutionAllow: params.toolExecutionAllow,
  }).filter(
    (tool) =>
      isCodeModeControlTool(tool) ||
      (tool.name !== TOOL_SEARCH_RAW_TOOL_NAME &&
        tool.name !== TOOL_DESCRIBE_RAW_TOOL_NAME &&
        tool.name !== TOOL_CALL_RAW_TOOL_NAME),
  );
  const directToolNames = new Set(params.directToolNames);
  const compacted = applyToolCatalogCompaction({
    ...params,
    tools,
    enabled: true,
    isVisibleControlTool: isCodeModeControlTool,
    // Code mode never exposes core shell/file tools just because structured
    // search does; only explicitly required, trusted direct tools may remain.
    isVisibleCatalogTool: (tool) =>
      directToolNames.has(tool.name) && isDirectVisibleCatalogTool(tool, directToolNames),
    shouldCatalogTool: (tool) => !isCodeModeControlTool(tool),
  });
  const catalogRef = params.catalogRef;
  const execTool = compacted.tools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
  if (catalogRef?.current && execTool) {
    // Refreshing descriptions replaces their observer, not the catalog's parked consumers.
    catalogRef.disposeObserver?.();
    const descriptionUpdater = createCodeModeExecDescriptionUpdater(execTool);
    catalogRef.disposeObserver = descriptionUpdater.dispose;
    catalogRef.onChange = () => {
      descriptionUpdater.update(
        createCodeModeExecDescription(
          { ...params, runtimeConfig: params.config },
          catalogRef.current?.entries,
        ),
      );
    };
    catalogRef.onChange();
  }
  return compacted;
}
