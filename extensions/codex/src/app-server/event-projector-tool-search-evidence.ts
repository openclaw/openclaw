import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type JsonObject } from "./protocol.js";
import type { CodexTrajectoryRecorder } from "./trajectory.js";

const MAX_RETAINED_SEARCHES = 16;
const MAX_RETAINED_DYNAMIC_CALLS = 32;
const MAX_DISCOVERED_TOOLS = 32;
const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 128;

type CodexToolSearchToolRef = {
  namespace?: string;
  name: string;
};

type CodexToolSearchCallReceipt = {
  callId: string;
  execution?: string;
  status?: string;
};

type CodexToolSearchOutputReceipt = {
  call: CodexToolSearchCallReceipt;
  execution?: string;
  status?: string;
  tools: CodexToolSearchToolRef[];
  truncated: boolean;
};

type CodexDynamicToolSearchLink = {
  search: CodexToolSearchOutputReceipt;
  namespace: string;
  tool: string;
};

function readBoundedString(value: unknown, maxChars: number): string | undefined {
  return normalizeOptionalString(value)?.slice(0, maxChars);
}

function collectToolRefs(
  values: unknown,
  output: CodexToolSearchToolRef[],
  seen: Set<string>,
  inheritedNamespace?: string,
): boolean {
  if (!Array.isArray(values)) {
    return false;
  }
  let truncated = false;
  for (const value of values) {
    if (!isJsonObject(value)) {
      continue;
    }
    const type = readBoundedString(value.type, MAX_NAME_CHARS);
    const name = readBoundedString(value.name, MAX_NAME_CHARS);
    if (type === "namespace" && name) {
      truncated = collectToolRefs(value.tools, output, seen, name) || truncated;
      continue;
    }
    if (type !== "function" || !name) {
      continue;
    }
    const namespace = readBoundedString(value.namespace, MAX_NAME_CHARS) ?? inheritedNamespace;
    const key = `${namespace ?? ""}\u0000${name}`;
    if (seen.has(key)) {
      continue;
    }
    if (output.length >= MAX_DISCOVERED_TOOLS) {
      truncated = true;
      continue;
    }
    seen.add(key);
    output.push({ ...(namespace ? { namespace } : {}), name });
  }
  return truncated;
}

/** Private-QA projection of searchable discovery receipts; never enters chat history. */
export class CodexToolSearchEvidenceProjection {
  private readonly calls = new Map<string, CodexToolSearchCallReceipt>();
  private readonly outputs = new Map<string, CodexToolSearchOutputReceipt>();
  private readonly dynamicCalls = new Map<string, CodexDynamicToolSearchLink>();

  constructor(
    private readonly recorder: CodexTrajectoryRecorder,
    private readonly threadId: string,
    private readonly turnId: string,
  ) {}

  recordRawResponseItem(item: JsonObject): void {
    const type = readBoundedString(item.type, MAX_NAME_CHARS);
    const callId = readBoundedString(item.call_id, MAX_ID_CHARS);
    if (!callId) {
      return;
    }
    if (type === "tool_search_call") {
      const execution = readBoundedString(item.execution, MAX_NAME_CHARS);
      const status = readBoundedString(item.status, MAX_NAME_CHARS);
      this.calls.set(callId, {
        callId,
        ...(execution ? { execution } : {}),
        ...(status ? { status } : {}),
      });
      pruneMapToMaxSize(this.calls, MAX_RETAINED_SEARCHES);
      return;
    }
    if (type !== "tool_search_output") {
      return;
    }
    const call = this.calls.get(callId);
    if (!call) {
      return;
    }
    const tools: CodexToolSearchToolRef[] = [];
    const truncated = collectToolRefs(item.tools, tools, new Set());
    const execution = readBoundedString(item.execution, MAX_NAME_CHARS);
    const status = readBoundedString(item.status, MAX_NAME_CHARS);
    this.outputs.set(callId, {
      call,
      ...(execution ? { execution } : {}),
      ...(status ? { status } : {}),
      tools,
      truncated,
    });
    pruneMapToMaxSize(this.outputs, MAX_RETAINED_SEARCHES);
  }

  recordDynamicToolCall(params: { callId: string; namespace?: string | null; tool: string }): void {
    const callId = readBoundedString(params.callId, MAX_ID_CHARS);
    const tool = readBoundedString(params.tool, MAX_NAME_CHARS);
    const requestedNamespace = readBoundedString(params.namespace, MAX_NAME_CHARS);
    if (!callId || !tool || !requestedNamespace || requestedNamespace !== params.namespace) {
      return;
    }
    const search = [...this.outputs.values()]
      .toReversed()
      .find((candidate) =>
        candidate.tools.some((ref) => ref.name === tool && ref.namespace === requestedNamespace),
      );
    if (!search) {
      return;
    }
    this.dynamicCalls.set(callId, {
      search,
      namespace: requestedNamespace,
      tool,
    });
    pruneMapToMaxSize(this.dynamicCalls, MAX_RETAINED_DYNAMIC_CALLS);
  }

  recordDynamicToolResult(params: { callId: string; tool: string; success: boolean }): void {
    const callId = readBoundedString(params.callId, MAX_ID_CHARS);
    const tool = readBoundedString(params.tool, MAX_NAME_CHARS);
    if (!callId || !tool) {
      return;
    }
    const link = this.dynamicCalls.get(callId);
    if (!link || link.tool !== tool) {
      return;
    }
    this.dynamicCalls.delete(callId);
    this.recorder.recordEvent("tool.search.discovery", {
      threadId: this.threadId,
      turnId: this.turnId,
      search: {
        callId: link.search.call.callId,
        ...(link.search.call.execution ? { callExecution: link.search.call.execution } : {}),
        ...(link.search.call.status ? { callStatus: link.search.call.status } : {}),
        ...(link.search.execution ? { outputExecution: link.search.execution } : {}),
        ...(link.search.status ? { outputStatus: link.search.status } : {}),
        tools: link.search.tools,
        ...(link.search.truncated ? { truncated: true } : {}),
      },
      target: {
        callId,
        namespace: link.namespace,
        name: tool,
        success: params.success,
      },
    });
  }
}
