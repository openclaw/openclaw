import { createHash } from "node:crypto";
import {
  formatNativeToolOutput,
  formatNativeToolSummary,
  MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM,
  NativeToolOutputAccumulator,
  truncateNativeToolTranscriptText,
  TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  formatToolProgressOutput,
  projectAgentToolActivity,
  sanitizeToolResult,
  TOOL_PROGRESS_OUTPUT_MAX_CHARS,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { AgentsApiEvent, AgentsApiItem } from "./agentsapi-client.js";
import {
  agentsApiNativeTool,
  agentsApiNativeToolDetails,
  agentsApiNativeToolOutcome,
  agentsApiNativeToolOutput,
  type AgentsApiNativeTool,
  type AgentsApiNativeToolOutcome,
} from "./agentsapi-native-items.js";
import {
  recordAgentsApiNativeToolInvocation,
  recordAgentsApiNativeToolTranscript,
} from "./agentsapi-transcript.js";

type AgentEvent = Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0];
type NativeToolState = {
  turnId: string;
  item: AgentsApiItem;
  canonicalItem?: AgentsApiItem;
  terminal: boolean;
  tool?: AgentsApiNativeTool;
  startProjected: boolean;
  callRecorded: boolean;
  resultRecorded: boolean;
  provisionalTerminalObserved: boolean;
  canonicalTerminalObserved: boolean;
  terminalProjectionHash?: string;
  recoveredPartial: boolean;
  outputProgressChars: number;
  outputProgressMessages: number;
  commandOutputChars: number;
  commandOutputMessages: number;
  recoveredOutput?: string;
  recoveredOutputTruncated?: boolean;
};

/** Native tools own lifecycle, bounded output, and canonical transcript facts. */
export class AgentsApiNativeToolProjection {
  private readonly items = new Map<string, NativeToolState>();
  private readonly turnByItem = new Map<string, string>();
  private readonly output = new NativeToolOutputAccumulator("Agents API");
  private readonly metas = new Map<string, AgentHarnessAttemptResult["toolMetas"][number]>();
  private nativeToolError: AgentHarnessAttemptResult["lastToolError"];

  constructor(
    private readonly params: AgentHarnessAttemptParamsV2,
    private readonly remoteSessionId: string,
    private readonly emitEvent: (event: AgentEvent) => void | Promise<void>,
    private readonly assertCurrent: () => void,
    private readonly nextTimestamp: () => number,
    private readonly isPresentationEnabled: () => boolean,
  ) {}

  get toolMetas(): AgentHarnessAttemptResult["toolMetas"] {
    return [...this.metas.values()];
  }

  get lastToolError(): AgentHarnessAttemptResult["lastToolError"] {
    return this.nativeToolError;
  }

  get itemLifecycle(): NonNullable<AgentHarnessAttemptResult["itemLifecycle"]> {
    const states = [...this.items.values()];
    const completedCount = states.filter((state) => state.terminal).length;
    return {
      startedCount: states.length,
      completedCount,
      activeCount: states.length - completedCount,
    };
  }

  get hadPotentialSideEffects(): boolean {
    return [...this.items.values()].some(
      (state) => state.item.type === "command_execution" || state.item.type === "mcp_call",
    );
  }

  resolveTurnId(itemId: string): string | undefined {
    return this.turnByItem.get(itemId);
  }

  async recordItem(
    turnId: string,
    item: AgentsApiItem,
    terminal: boolean,
    enclosingStatus?: string,
    canonical = false,
    recordTranscript = true,
  ): Promise<boolean> {
    this.assertCurrent();
    const tool = agentsApiNativeTool(item, this.params);
    if (!tool) {
      return false;
    }
    const id = this.identity(turnId, item.id);
    let state = this.items.get(id);
    if (state?.terminal && !canonical) {
      return true;
    }
    if (!state) {
      state = {
        turnId,
        item,
        tool,
        terminal: false,
        startProjected: false,
        callRecorded: false,
        resultRecorded: false,
        provisionalTerminalObserved: false,
        canonicalTerminalObserved: false,
        recoveredPartial: false,
        outputProgressChars: 0,
        outputProgressMessages: 0,
        commandOutputChars: 0,
        commandOutputMessages: 0,
      };
      this.items.set(id, state);
      this.turnByItem.set(item.id, turnId);
    }
    state.item = item;
    state.tool = tool;
    if (canonical) {
      state.canonicalItem = item;
    }
    // Saved state has no replay cursor. Recovered partial output waits for an
    // authoritative completion; new native tool items continue streaming.
    if (canonical && !terminal) {
      state.recoveredPartial = true;
      if (item.type === "command_execution" && typeof item.output === "string") {
        state.recoveredOutput = agentsApiNativeToolOutput(item);
        state.recoveredOutputTruncated = item.output.length > TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS;
      }
    }
    await this.startTool(state);
    if (canonical && recordTranscript && !state.callRecorded) {
      state.callRecorded = await recordAgentsApiNativeToolInvocation(
        this.params,
        this.remoteSessionId,
        turnId,
        item,
        this.assertCurrent,
        this.nextTimestamp,
      );
    }
    if (terminal) {
      await this.finishTool(state, enclosingStatus, canonical, recordTranscript);
    }
    state.terminal = terminal;
    return true;
  }

  async reconcileRemaining(
    turnId: string,
    status: string | undefined,
    currentItemIds: ReadonlySet<string>,
  ): Promise<boolean> {
    this.assertCurrent();
    let transcriptReady = true;
    for (const state of this.items.values()) {
      if (state.turnId !== turnId || (state.resultRecorded && state.canonicalTerminalObserved)) {
        continue;
      }
      if (!state.resultRecorded && !currentItemIds.has(state.item.id)) {
        // Retain previously retrieved facts, but do not promise their original
        // position when the terminal snapshot no longer contains this item.
        transcriptReady = false;
      }
      await this.finishTool(state, status, true);
      state.terminal = true;
    }
    return transcriptReady;
  }

  async observeOutput(event: AgentsApiEvent): Promise<void> {
    this.assertCurrent();
    const state = this.eventItem(event);
    if (
      !state ||
      state.terminal ||
      state.recoveredPartial ||
      state.item.type !== "command_execution" ||
      !event.delta
    ) {
      return;
    }
    const id = this.identity(state.turnId, state.item.id);
    const delta = sanitizeToolResult(event.delta);
    this.output.append(id, delta);
    if (
      state.commandOutputChars < TOOL_PROGRESS_OUTPUT_MAX_CHARS &&
      state.commandOutputMessages < MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM
    ) {
      const remaining = TOOL_PROGRESS_OUTPUT_MAX_CHARS - state.commandOutputChars;
      const text = truncateUtf16Safe(delta, remaining);
      state.commandOutputChars += text.length;
      state.commandOutputMessages += 1;
      await this.emit({
        stream: "command_output",
        data: {
          itemId: id,
          toolCallId: id,
          phase: "delta",
          name: state.tool?.name ?? "bash",
          title:
            typeof state.tool?.args.command === "string"
              ? state.tool.args.command
              : "Command output",
          output: delta.length > remaining ? `${text}\n...(truncated)...` : text,
          status: "running",
          ...(typeof state.tool?.args.cwd === "string" ? { cwd: state.tool.args.cwd } : {}),
        },
      });
    }
    await this.emitToolOutput(state, event.delta, false);
  }

  private async startTool(state: NativeToolState): Promise<void> {
    if (!state.tool || state.startProjected) {
      return;
    }
    const id = this.identity(state.turnId, state.item.id);
    const { name, args, meta, commandBearing } = state.tool;
    state.startProjected = true;
    this.metas.set(id, { toolCallId: id, toolName: name, ...(meta ? { meta } : {}) });
    await this.emit({
      stream: "item",
      data: projectAgentToolActivity({ toolCallId: id, name, phase: "start", args, meta }),
    });
    await this.emit({
      stream: "tool",
      data: {
        phase: "start",
        itemId: id,
        toolCallId: id,
        name,
        args,
        ...(meta ? { meta } : {}),
        ...(commandBearing ? { commandBearing: true } : {}),
      },
    });
    if (this.shouldEmitToolResult()) {
      await this.emitToolProgress(
        id,
        formatNativeToolSummary(name, this.formattedMeta(state.tool)),
      );
    }
  }

  private async finishTool(
    state: NativeToolState,
    enclosingStatus?: string,
    canonical = false,
    recordTranscript = true,
  ): Promise<void> {
    if (!state.tool) {
      return;
    }
    const id = this.identity(state.turnId, state.item.id);
    const item = canonical ? (state.canonicalItem ?? state.item) : state.item;
    const tool =
      canonical && state.canonicalItem
        ? agentsApiNativeTool(state.canonicalItem, this.params)
        : state.tool;
    if (!tool) {
      return;
    }
    const { name, args, meta, commandBearing } = tool;
    const savedItemUnavailable = canonical && !state.canonicalItem;
    const outcome: AgentsApiNativeToolOutcome = savedItemUnavailable
      ? {
          status: enclosingStatus === "cancelled" ? "cancelled" : "unknown",
          isError: true,
          outcomeUnknown: enclosingStatus !== "cancelled",
          error:
            enclosingStatus === "cancelled"
              ? "Agents API native tool was cancelled"
              : "Agents API native tool item is unavailable in saved state",
        }
      : agentsApiNativeToolOutcome(item, enclosingStatus);
    const capturedOutput = state.recoveredOutput ?? this.output.textByItem.get(id);
    const output = agentsApiNativeToolOutput(item, capturedOutput);
    const details = {
      ...agentsApiNativeToolDetails(
        this.remoteSessionId,
        state.turnId,
        item,
        outcome,
        capturedOutput,
      ),
      ...(savedItemUnavailable
        ? {
            savedItemAvailability: "unavailable",
            ...(item.type !== "web_search_call"
              ? { outputAvailability: output === undefined ? "unavailable" : "partial" }
              : {}),
          }
        : {}),
    };
    const captureTruncated =
      item.output == null && (state.recoveredOutputTruncated || this.output.isTruncated(id));
    this.metas.set(id, {
      toolCallId: id,
      toolName: name,
      ...(meta ? { meta } : {}),
      isError: outcome.isError,
    });
    if (canonical && recordTranscript && state.canonicalItem && !state.resultRecorded) {
      // Only retrieved items supply durable calls and results. Streamed tool
      // names, arguments, and output may still be partial.
      state.resultRecorded = await recordAgentsApiNativeToolTranscript(
        this.params,
        this.remoteSessionId,
        state.turnId,
        state.canonicalItem,
        this.assertCurrent,
        this.nextTimestamp,
        { enclosingStatus, capturedOutput, captureTruncated },
      );
    }
    if (
      canonical &&
      (state.canonicalItem ? !state.canonicalTerminalObserved : !state.provisionalTerminalObserved)
    ) {
      this.assertCurrent();
      const resolution = this.params.observeToolTerminal?.({
        toolCallId: id,
        toolName: name,
        arguments: args,
        ...(meta ? { meta } : {}),
        executionStarted: true,
        outcome: outcome.isError ? "failure" : "success",
        ...(outcome.isError
          ? {
              failure: {
                ...(outcome.error ? { error: outcome.error } : {}),
                ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
              },
            }
          : {}),
        nativeMutation: {
          mutatingAction: item.type !== "web_search_call",
          replaySafe: item.type === "web_search_call",
        },
      });
      this.assertCurrent();
      if (state.canonicalItem) {
        state.canonicalTerminalObserved = true;
      } else {
        state.provisionalTerminalObserved = true;
      }
      if (resolution) {
        this.nativeToolError = resolution.lastToolError;
      } else if (outcome.isError) {
        this.nativeToolError = {
          toolName: name,
          ...(meta ? { meta } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
          ...(item.type !== "web_search_call" ? { mutatingAction: true } : {}),
        };
      } else if (this.nativeToolError?.mutatingAction !== true) {
        this.nativeToolError = undefined;
      }
    }
    this.assertCurrent();
    if (!this.isPresentationEnabled()) {
      return;
    }
    const commandFacts = commandBearing
      ? {
          title: typeof args.command === "string" ? args.command : "Command output",
          ...(!savedItemUnavailable && typeof item.exit_code === "number"
            ? { exitCode: item.exit_code }
            : {}),
          ...(!savedItemUnavailable && typeof item.duration_ms === "number"
            ? { durationMs: item.duration_ms }
            : {}),
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
        }
      : undefined;
    const presentationOutput =
      output !== undefined && commandBearing ? (formatToolProgressOutput(output) ?? "") : output;
    const toolSnapshot = {
      phase: "result",
      itemId: id,
      toolCallId: id,
      name,
      args,
      status: outcome.status,
      isError: outcome.isError,
      result: details,
      ...(presentationOutput !== undefined ? { output: presentationOutput } : {}),
      ...(meta ? { meta } : {}),
      ...(commandBearing ? { commandBearing: true, ...commandFacts } : {}),
    };
    const itemSnapshot = projectAgentToolActivity({
      toolCallId: id,
      name,
      phase: "result",
      args,
      meta,
      status: outcome.status === "cancelled" ? "unknown" : outcome.status,
      result: { details },
      isError: outcome.isError,
    });
    const commandSnapshot = commandFacts
      ? {
          itemId: id,
          toolCallId: id,
          phase: "end",
          name,
          ...commandFacts,
          ...(presentationOutput !== undefined ? { output: presentationOutput } : {}),
          status: outcome.status,
        }
      : undefined;
    // The bounded digest detects changed projected facts without retaining a
    // second payload. Canonical enrichment replaces the same terminal item.
    const projectionHash = nativeTerminalProjectionHash({
      tool: toolSnapshot,
      item: itemSnapshot,
      command: commandSnapshot,
    });
    if (state.terminalProjectionHash === projectionHash) {
      return;
    }
    const replacement = {
      replaceable: true,
      ...(state.terminalProjectionHash ? { replace: true } : {}),
    };
    await this.emit({ stream: "tool", data: { ...toolSnapshot, ...replacement } });
    await this.emit({ stream: "item", data: { ...itemSnapshot, ...replacement } });
    if (commandSnapshot) {
      await this.emit({ stream: "command_output", data: { ...commandSnapshot, ...replacement } });
    }
    state.terminalProjectionHash = projectionHash;
    if (output !== undefined && state.outputProgressMessages === 0) {
      await this.emitToolOutput(state, output, true, outcome.isError);
    }
  }

  private async emitToolOutput(
    state: NativeToolState,
    output: string,
    terminal: boolean,
    isError = false,
  ): Promise<void> {
    if (
      !state.tool ||
      !this.shouldEmitToolOutput() ||
      state.outputProgressChars >= TOOL_PROGRESS_OUTPUT_MAX_CHARS ||
      state.outputProgressMessages >= MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM
    ) {
      return;
    }
    const remaining = TOOL_PROGRESS_OUTPUT_MAX_CHARS - state.outputProgressChars;
    const sanitized = sanitizeToolResult(output);
    const truncated = sanitized.length > remaining;
    const text = truncateUtf16Safe(sanitized, remaining);
    state.outputProgressChars += text.length;
    state.outputProgressMessages += 1;
    await this.emitToolProgress(
      this.identity(state.turnId, state.item.id),
      formatNativeToolOutput(
        state.tool.name,
        this.formattedMeta(state.tool),
        truncated ? `${text}\n...(truncated)...` : text,
      ),
      terminal && isError,
    );
  }

  private async emitToolProgress(itemId: string, text: string, isError = false): Promise<void> {
    this.assertCurrent();
    if (!this.isPresentationEnabled()) {
      return;
    }
    await this.params.onToolResult?.({
      text: truncateNativeToolTranscriptText(text, "Agents API"),
      ...(this.params.messageChannel || this.params.messageProvider
        ? { channelData: { openclawToolProgressId: `tool:${itemId}` } }
        : {}),
      ...(isError ? { isError: true } : {}),
    });
    this.assertCurrent();
  }

  private formattedMeta(tool: AgentsApiNativeTool): string | undefined {
    return !tool.commandBearing ||
      (!(this.params.messageChannel ?? this.params.messageProvider) && this.shouldEmitToolOutput())
      ? tool.meta
      : undefined;
  }

  private shouldEmitToolResult(): boolean {
    this.assertCurrent();
    if (!this.isPresentationEnabled()) {
      return false;
    }
    return (
      this.params.shouldEmitToolResult?.() ??
      (this.params.verboseLevel === "on" || this.params.verboseLevel === "full")
    );
  }

  private shouldEmitToolOutput(): boolean {
    this.assertCurrent();
    if (!this.isPresentationEnabled()) {
      return false;
    }
    return this.params.shouldEmitToolOutput?.() ?? this.params.verboseLevel === "full";
  }

  private eventItem(event: AgentsApiEvent): NativeToolState | undefined {
    if (!event.item_id) {
      throw new Error("Agents API output event has no item identity");
    }
    const turnId = event.turn_id ?? this.turnByItem.get(event.item_id);
    return turnId ? this.items.get(this.identity(turnId, event.item_id)) : undefined;
  }

  private identity(turnId: string, itemId: string): string {
    return `agentsapi:${this.remoteSessionId}:${turnId}:${itemId}`;
  }

  private async emit(event: AgentEvent): Promise<void> {
    this.assertCurrent();
    if (!this.isPresentationEnabled()) {
      return;
    }
    await this.emitEvent(event);
    this.assertCurrent();
  }
}

function nativeTerminalProjectionHash(snapshot: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(snapshot, (_key, value: unknown) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return value;
        }
        return Object.fromEntries(
          Object.entries(value).toSorted(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        );
      }),
    )
    .digest("hex");
}
