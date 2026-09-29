/** MCP namespace descriptors, API files, and their catalog-bound invocation runtime. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { tokTypes } from "acorn";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import type { PluginToolMcpMeta } from "../plugins/tool-metadata.js";
import { sanitizeNodeIdFragment } from "./agent-bundle-mcp-names.js";
import { toCodeModeJsonSafe } from "./code-mode-json.js";
import {
  buildMcpApiResponse,
  buildMcpParamDocs,
  createMcpApiVirtualFiles,
  readMcpRequiredKeys,
  readMcpSchemaProperties,
  type CodeModeApiVirtualFile,
  type McpApiServerDoc,
} from "./code-mode-mcp-api.js";

export type { CodeModeApiVirtualFile } from "./code-mode-mcp-api.js";

const FORBIDDEN_NAMESPACE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const NAMESPACE_PATH_KEY_SEPARATOR = "\u0000";
const RESERVED_NAMESPACE_GLOBALS = new Set([
  "ALL_TOOLS",
  "agents",
  "API",
  "Array",
  "Boolean",
  "catalog",
  "clearTimeout",
  "Date",
  "Error",
  "globalThis",
  "log",
  "json",
  "JSON",
  "Map",
  "Math",
  "MCP",
  "namespaces",
  "nodes",
  "Number",
  "Object",
  "Promise",
  "phase",
  "Set",
  "setTimeout",
  "skills",
  "String",
  "text",
  "tools",
  "yield_control",
]);
// API declarations use function names, so JS keywords and TypeScript's `enum`
// must be escaped even though those words are valid MCP tool identifiers.
const RESERVED_NAMESPACE_FUNCTION_IDENTIFIERS = new Set([
  ...Object.values(tokTypes).flatMap((token) => (token.keyword ? [token.keyword] : [])),
  "enum",
]);

type McpNamespaceScope = Map<
  string,
  string | McpNamespaceScope | { kind: "function"; path: string[] }
>;

type McpNamespaceCall = {
  input: (args: unknown[]) => unknown;
  tool?: { catalogId: string; toolName: string };
};

/** JSON-serializable descriptor value emitted to the code-mode runtime. */
export type SerializedCodeModeNamespaceValue =
  | { kind: "array"; items: SerializedCodeModeNamespaceValue[] }
  | { kind: "function"; path: string[] }
  | { kind: "object"; entries: Array<[string, SerializedCodeModeNamespaceValue]> }
  | { kind: "value"; value: unknown };

/** Descriptor sent to code mode for one visible namespace. */
export type CodeModeNamespaceDescriptor = {
  id: string;
  globalName: string;
  description?: string;
  scope: SerializedCodeModeNamespaceValue;
};

type CodeModeNamespaceCatalogEntry = {
  id?: string;
  source?: string;
  name: string;
  sourceName?: string;
  description?: string;
  parameters?: unknown;
  mcp?: PluginToolMcpMeta;
};

/** Discovery routes derive from the same model that installs namespace functions. */
type CodeModeMcpCatalogBinding = {
  callableName: string;
  namespaceId: "mcp";
  path: string[];
  apiPath: string;
};

/** Runtime dispatcher for invoking callable namespace paths. */
export type CodeModeNamespaceRuntime = {
  descriptors: CodeModeNamespaceDescriptor[];
  apiFiles: CodeModeApiVirtualFile[];
  mcpBindings: ReadonlyMap<string, CodeModeMcpCatalogBinding>;
  invoke(
    namespaceId: string,
    path: string[],
    args: unknown[],
    executeTool: (params: {
      pluginId: string;
      toolName: string;
      catalogId: string;
      input: unknown;
      namespaceId: string;
      path: string[];
    }) => Promise<unknown>,
  ): Promise<unknown>;
};

function toIdentifier(value: string, fallback: string): string {
  const words = value
    .trim()
    .split(/[^A-Za-z0-9]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
  const base =
    words.length === 0
      ? fallback
      : words
          .map((word, index) =>
            index === 0
              ? word.charAt(0).toLowerCase() + word.slice(1)
              : word.charAt(0).toUpperCase() + word.slice(1),
          )
          .join("");
  const safe = base.replace(/^[^A-Za-z_$]+/u, "").replace(/[^A-Za-z0-9_$]/gu, "");
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(safe) ? safe : fallback;
}

function uniqueIdentifier(base: string, used: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (
    used.has(candidate) ||
    RESERVED_NAMESPACE_GLOBALS.has(candidate) ||
    RESERVED_NAMESPACE_FUNCTION_IDENTIFIERS.has(candidate) ||
    FORBIDDEN_NAMESPACE_PATH_SEGMENTS.has(candidate)
  ) {
    candidate = `${base}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function mapMcpNamespaceInput(schema: unknown, args: unknown[]): unknown {
  if (args.length > 1) {
    throw new Error("MCP namespace tools accept one object argument.");
  }
  const firstArg = args[0];
  const input: Record<string, unknown> =
    firstArg === undefined ? {} : isRecord(firstArg) ? { ...firstArg } : {};
  if (firstArg !== undefined && !isRecord(firstArg)) {
    throw new Error("MCP namespace tools accept one object argument.");
  }
  for (const [key, descriptor] of Object.entries(readMcpSchemaProperties(schema))) {
    if (
      !isRecord(descriptor) ||
      !Object.hasOwn(descriptor, "default") ||
      (Object.hasOwn(input, key) && input[key] !== undefined)
    ) {
      continue;
    }
    // MCP schemas are untrusted; defining an own key keeps __proto__ a value, not a setter.
    Object.defineProperty(input, key, {
      value: descriptor.default,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const missing = readMcpRequiredKeys(schema).filter(
    (key) => !Object.hasOwn(input, key) || input[key] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required MCP namespace argument${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }
  return input;
}

function scopeAtPath(root: McpNamespaceScope, path: readonly string[]): McpNamespaceScope {
  let current = root;
  for (const segment of path) {
    const existing = current.get(segment);
    const next: McpNamespaceScope = existing instanceof Map ? existing : new Map();
    current.set(segment, next);
    current = next;
  }
  return current;
}

function toolIdentifiersForServer(
  usedToolIdentifiers: Map<string, Set<string>>,
  serverIdentifier: string,
): Set<string> {
  const existing = usedToolIdentifiers.get(serverIdentifier);
  if (existing) {
    return existing;
  }
  const created = new Set<string>(["$api", "resources", "prompts"]);
  usedToolIdentifiers.set(serverIdentifier, created);
  return created;
}

type McpNamespaceModel = {
  root: McpNamespaceScope;
  calls: Map<string, McpNamespaceCall>;
  docs: McpApiServerDoc[];
  bindings: Map<string, CodeModeMcpCatalogBinding>;
};

type McpNamespaceServer = {
  key: string;
  serverName: string;
  safeServerName: string;
  node?: NonNullable<NonNullable<CodeModeNamespaceCatalogEntry["mcp"]>["node"]>;
};

function mcpNamespaceServerKey(mcp: NonNullable<CodeModeNamespaceCatalogEntry["mcp"]>): string {
  return mcp.node
    ? JSON.stringify(["node", mcp.node.id, mcp.serverName])
    : JSON.stringify(["gateway", mcp.safeServerName]);
}

function assignMcpNamespaceServerNames(
  servers: readonly McpNamespaceServer[],
): Map<string, string> {
  const baseCounts = new Map<string, number>();
  const used = new Set<string>();
  const assignments = new Map<string, string>();
  for (const server of servers) {
    const normalized = server.safeServerName.toLowerCase();
    baseCounts.set(normalized, (baseCounts.get(normalized) ?? 0) + 1);
    if (!server.node) {
      assignments.set(server.key, server.safeServerName);
      used.add(normalized);
    }
  }
  for (const server of servers) {
    if (!server.node || (baseCounts.get(server.safeServerName.toLowerCase()) ?? 0) > 1) {
      continue;
    }
    assignments.set(server.key, server.safeServerName);
    used.add(server.safeServerName.toLowerCase());
  }
  for (const server of servers) {
    if (!server.node || assignments.has(server.key)) {
      continue;
    }
    const base = `${sanitizeNodeIdFragment(server.node.id)}_${server.safeServerName}`;
    let candidate = base;
    let index = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base}_${index}`;
      index += 1;
    }
    assignments.set(server.key, candidate);
    used.add(candidate.toLowerCase());
  }
  return assignments;
}

function mcpNodeLabel(node: NonNullable<McpNamespaceServer["node"]>): string {
  return truncateUtf16Safe((node.displayName?.trim() || node.id).replace(/\s+/gu, " "), 128);
}

// Prompt preparation needs the same server names without building tool scopes or schema docs.
function createMcpNamespacePlan(catalog: readonly CodeModeNamespaceCatalogEntry[]) {
  const mcpEntries = catalog
    .filter((entry) => entry.source === "mcp" && entry.id && entry.mcp)
    .toSorted((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
  if (mcpEntries.length === 0) {
    return undefined;
  }
  const serversByKey = new Map<string, McpNamespaceServer>();
  for (const entry of mcpEntries) {
    const mcp = entry.mcp;
    if (!mcp) {
      continue;
    }
    const key = mcpNamespaceServerKey(mcp);
    if (!serversByKey.has(key)) {
      serversByKey.set(key, {
        key,
        serverName: mcp.serverName,
        safeServerName: mcp.safeServerName,
        ...(mcp.node ? { node: mcp.node } : {}),
      });
    }
  }
  const servers = [...serversByKey.values()].toSorted((a, b) => a.key.localeCompare(b.key));
  const assignedServerNames = assignMcpNamespaceServerNames(servers);
  const namedServers = new Map<string, McpNamespaceServer & { identifier: string }>();
  const usedServerIdentifiers = new Set<string>();
  for (const server of servers) {
    const safeServerName = assignedServerNames.get(server.key) ?? server.safeServerName;
    namedServers.set(server.key, {
      ...server,
      identifier: uniqueIdentifier(toIdentifier(safeServerName, "server"), usedServerIdentifiers),
    });
  }
  return { entries: mcpEntries, servers: namedServers, usedServerIdentifiers };
}

function createMcpNamespaceModel(
  catalog: readonly CodeModeNamespaceCatalogEntry[],
): McpNamespaceModel | undefined {
  const plan = createMcpNamespacePlan(catalog);
  if (!plan) {
    return undefined;
  }
  const usedToolIdentifiers = new Map<string, Set<string>>();
  const root: McpNamespaceScope = new Map();
  const calls = new Map<string, McpNamespaceCall>();
  const addCall = (path: string[], call: McpNamespaceCall) => {
    scopeAtPath(root, path.slice(0, -1)).set(path.at(-1)!, { kind: "function", path });
    calls.set(namespacePathKey(path), call);
  };
  const serverDocs = new Map<string, McpApiServerDoc>();
  const bindings = new Map<string, CodeModeMcpCatalogBinding>();
  for (const entry of plan.entries) {
    const mcp = entry.mcp;
    if (!mcp || !entry.id) {
      continue;
    }
    const serverKey = mcpNamespaceServerKey(mcp);
    const serverIdentifier =
      plan.servers.get(serverKey)?.identifier ??
      uniqueIdentifier("server", plan.usedServerIdentifiers);
    const serverScope = scopeAtPath(root, [serverIdentifier]);
    serverScope.set("$serverName", mcp.serverName);
    let serverDoc = serverDocs.get(serverIdentifier);
    if (!serverDoc) {
      serverDoc = {
        identifier: serverIdentifier,
        serverName: mcp.serverName,
        ...(mcp.node ? { nodeLabel: mcpNodeLabel(mcp.node) } : {}),
        tools: [],
      };
      serverDocs.set(serverIdentifier, serverDoc);
    }
    const path =
      mcp.operation === "resources_list"
        ? ["resources", "list"]
        : mcp.operation === "resources_read"
          ? ["resources", "read"]
          : mcp.operation === "prompts_list"
            ? ["prompts", "list"]
            : mcp.operation === "prompts_get"
              ? ["prompts", "get"]
              : [
                  uniqueIdentifier(
                    toIdentifier(mcp.toolName, "tool"),
                    toolIdentifiersForServer(usedToolIdentifiers, serverIdentifier),
                  ),
                ];
    bindings.set(entry.id, {
      callableName: ["MCP", serverIdentifier, ...path].join("."),
      namespaceId: "mcp",
      path: [serverIdentifier, ...path],
      apiPath: `mcp/${serverIdentifier}.d.ts`,
    });
    const catalogId = entry.id.trim();
    const toolName = entry.name.trim();
    if (!catalogId) {
      throw new Error("Code mode namespace catalogId must be non-empty.");
    }
    if (!toolName) {
      throw new Error("Code mode namespace toolName must be non-empty.");
    }
    addCall([serverIdentifier, ...path], {
      tool: { toolName, catalogId },
      input: (args) => mapMcpNamespaceInput(entry.parameters, args),
    });
    serverDoc.tools.push({
      method: path.join("."),
      path,
      mcpTool: mcp.toolName,
      operation: mcp.operation,
      description: entry.description,
      parameters: entry.parameters,
      params: buildMcpParamDocs(entry.parameters),
    });
  }
  const docs = Array.from(serverDocs.values(), (server) => {
    // The model owns these rows until namespace/API publication.
    server.tools = server.tools.toSorted((a, b) => a.method.localeCompare(b.method));
    return server;
  }).toSorted((a, b) => a.identifier.localeCompare(b.identifier));
  addCall(["$api"], { input: (args) => buildMcpApiResponse({ servers: docs, args }) });
  for (const server of docs) {
    addCall([server.identifier, "$api"], {
      input: (args) => buildMcpApiResponse({ servers: docs, server, args }),
    });
  }
  return { root, calls, docs, bindings };
}

const SWARM_AGENTS_API_CONTENT = `type AgentJsonSchema = Record<string, unknown>;

interface AgentRunOptions {
  label?: string;
  model?: string;
  thinking?: string;
  fastMode?: boolean | "auto";
  agentId?: string;
  schema?: AgentJsonSchema;
  phase?: string;
}

interface AgentsApi {
  /** Reserve agents.run fan-out for batches; a single child uses sessions_spawn directly (announcing run). Child failures have name "SwarmAgentError", runId, status, and message; SwarmAgentError is not a global constructor. */
  run(prompt: string, options?: AgentRunOptions & { schema?: undefined }): Promise<string>;
  run<T>(prompt: string, options: AgentRunOptions & { schema: AgentJsonSchema }): Promise<T>;
}

/** Spawn collector agents concurrently; requests queue when bridge slots are full. */
declare const agents: Readonly<AgentsApi>;
/** Publish a phase heading for this swarm. */
declare function phase(title: string): void;
/** Publish a progress note for this swarm. */
declare function log(message: string): void;

// Fan-out: const settled = await Promise.allSettled(prompts.map((prompt) => agents.run(prompt)));
// Drain every accepted child before synthesis: fulfilled entries hold values, rejected entries hold reasons.
// Keep successful results and report failed lanes. Do not respawn completed work after a partial failure.
// Gate: for (let pass = 0; !ready && pass < 4; pass++) ready = await agents.run("Check readiness") === "ready";
// Cycle: for (let pass = 0; pass < 3; pass++) draft = await agents.run("Improve: " + draft);
// Schema: const fact = await agents.run<{ answer: string }>("Research", { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } });
`;

function describeMcpNamespaceForPrompt(
  catalog: readonly CodeModeNamespaceCatalogEntry[],
): string[] {
  const plan = createMcpNamespacePlan(catalog);
  if (!plan) {
    return [];
  }
  const servers = [...plan.servers.values()]
    .toSorted((a, b) => a.identifier.localeCompare(b.identifier))
    .map((server) => {
      const nodeLabel = server.node ? mcpNodeLabel(server.node) : undefined;
      return `${server.identifier}${nodeLabel ? ` (node: ${nodeLabel})` : ""}`;
    });
  if (servers.length === 0) {
    return [];
  }
  // Node-backed servers keep the gateway-style name when unique. Collisions
  // use the existing node-id fragment prefix idiom, then a numeric suffix.
  return [
    "- MCP: MCP server tools grouped by server.",
    `Read API files such as mcp/index.d.ts and mcp/<server>.d.ts for TypeScript-style MCP headers; visible servers: ${servers.join(", ")}. Node-backed name collisions use a sanitized node-id fragment prefix.`,
    "Search native and MCP tools by task with catalog.search(query). MCP handles expose callableName, apiPath, and describe() for the exact header and schema. Call the handle or MCP.<server>.<tool>({ ...input }) with one object argument matching the header.",
  ];
}

/** Builds system-prompt text describing visible code-mode namespace globals. */
export function describeCodeModeNamespacesForPrompt(
  catalog?: readonly CodeModeNamespaceCatalogEntry[],
): string {
  if (!catalog) {
    return "";
  }
  const mcpPrompt = describeMcpNamespaceForPrompt(catalog);
  if (mcpPrompt.length === 0) {
    return "";
  }
  const lines = ["MCP namespace globals are available in code mode:"];
  lines.push(...mcpPrompt);
  return lines.join("\n");
}

function assertNamespacePathSegment(segment: string): void {
  if (
    !segment ||
    segment.includes(NAMESPACE_PATH_KEY_SEPARATOR) ||
    FORBIDDEN_NAMESPACE_PATH_SEGMENTS.has(segment)
  ) {
    throw new Error(`Invalid code mode namespace path segment: ${segment || "(empty)"}`);
  }
}

function namespacePathKey(path: readonly string[]): string {
  return path.join(NAMESPACE_PATH_KEY_SEPARATOR);
}

function serializeMcpNamespaceScope(scope: McpNamespaceScope): SerializedCodeModeNamespaceValue {
  return {
    kind: "object",
    entries: Array.from(scope, ([key, value]) => [
      key,
      value instanceof Map
        ? serializeMcpNamespaceScope(value)
        : typeof value === "string"
          ? { kind: "value", value }
          : value,
    ]),
  };
}

/** Creates the runtime descriptor/invocation layer for visible namespaces. */
export function createCodeModeNamespaceRuntime(
  catalog: readonly CodeModeNamespaceCatalogEntry[] = [],
): CodeModeNamespaceRuntime {
  const model = createMcpNamespaceModel(catalog);
  return {
    descriptors: model
      ? [
          {
            id: "mcp",
            globalName: "MCP",
            description: "MCP server tools grouped by server.",
            scope: serializeMcpNamespaceScope(model.root),
          },
        ]
      : [],
    mcpBindings: model?.bindings ?? new Map(),
    apiFiles: [
      {
        path: "agents.d.ts",
        description: "Swarm collector globals and orchestration idioms.",
        content: SWARM_AGENTS_API_CONTENT,
        bytes: Buffer.byteLength(SWARM_AGENTS_API_CONTENT, "utf8"),
      },
      ...createMcpApiVirtualFiles(model?.docs ?? []),
    ],
    async invoke(namespaceId, path, args, executeTool) {
      if (!model || namespaceId !== "mcp") {
        throw new Error(`Unknown code mode namespace: ${namespaceId}`);
      }
      for (const segment of path) {
        assertNamespacePathSegment(segment);
      }
      const target = model.calls.get(namespacePathKey(path));
      if (!target) {
        throw new Error(`Code mode namespace path is not callable: ${path.join(".")}`);
      }
      const input = await target.input(args);
      if (!target.tool) {
        return toCodeModeJsonSafe(input);
      }
      return toCodeModeJsonSafe(
        await executeTool({
          pluginId: "bundle-mcp",
          ...target.tool,
          input,
          namespaceId,
          path: [...path],
        }),
      );
    },
  };
}
