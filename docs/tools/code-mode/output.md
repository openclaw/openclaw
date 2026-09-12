---
summary: "Declared output contracts for tool results and the guest output API"
title: "Code Mode output"
read_when:
  - You are declaring an outputSchema for a tool used in Code Mode
  - You need the text, json, and returned-value output rules
  - You are debugging a raw-first or shaped tool result
---

## Declared output contracts

OpenClaw tools can declare `outputSchema` for the structured value placed in
`AgentToolResult.details`. This is useful for Code Mode and Tool Search; it is
not a provider-native tool response schema and does not change direct tool
exposure.

For a tool made with `defineToolPlugin`, declare the schema beside
`parameters`:

```typescript
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

const Shipment = Type.Object(
  {
    id: Type.String(),
    paid: Type.Boolean(),
    tons: Type.Number(),
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: "shipping",
  name: "Shipping",
  description: "Shipment tools.",
  tools: (tool) => [
    tool({
      name: "shipping_list",
      description: "List shipments.",
      parameters: Type.Object({}),
      outputSchema: Type.Array(Shipment),
      execute: async () => loadShipments(),
    }),
  ],
});
```

For `api.registerTool(...)` or a factory tool, put the same `outputSchema`
property on the returned `AnyAgentTool` object.

Current built-in contracts include `agents_list`, `agents_wait`, `apply_patch`,
`conversations_list`, `conversations_send`, `conversations_turn`, `edit`,
`openclaw`, `read`, `screen`,
`sessions_history`, `sessions_list`, `sessions_search`, `sessions_send`,
`session_status`, `suggest_task`, `terminal`, `web_fetch`, and `web_search`.
Exact passthroughs can reuse their owning protocol schema instead of
duplicating a model-only contract. For example, the conversation tools expose
the same Gateway result schemas used by `conversations.list`,
`conversations.send`, and `conversations.turn`; `web_fetch` owns a tool-local
schema whose hint exposes stable metadata, text, cache state, and nested spill
metadata; `web_search` declares its exact normalized results/answer/error/raw
union as a complete quick-index hint. Filesystem contracts return structured
read text, image, truncation, and optional-not-found outcomes; explicit edit
change state plus diff/patch data; and apply-patch path summaries. Missing
canonical daily notes (`memory/YYYY-MM-DD.md`) return an optional `not_found`
result even when `optional` is omitted; other missing paths throw unless
`optional: true` is explicitly supplied. When the quick index declares the
fields, one cell can compose discovery and delivery without a separate
inspection turn:

```javascript
const listed = await conversations_list({ query: "build bot" });
const target = listed.conversations.find((item) => item.label === "Build bot");
if (!target) throw new Error("conversation not found");
return await conversations_send({
  conversationRef: target.conversationRef,
  message: "Build finished.",
});
```

The nested calls still use normal tool policy, hooks, and approvals. If a full
contract is exact but too large for the bounded quick index, it remains
available through the callable handle's `describe()` and the arrow stays
`-> ?`.

Full native-tool declarations are also available on demand through
`API.list("tools")` and `API.read("tools/<callableName>.d.ts")`, using the same
final callable names as discovery. These declarations are generated from the
effective input and trusted output schemas, not from the shortened quick index.
Native listing entries contain paths; `bytes` is available after `API.read`
generates the file. Files are not eagerly injected into every guest VM.
Unknown outputs and unsupported schema leaves remain `unknown`; client schemas
are not promoted into trusted declarations. Runtime validation remains the
source of truth for constraints TypeScript cannot express. Native declarations allow
omitting the input argument only when the effective schema accepts the empty
object used by runtime normalization; genuinely required inputs remain required.

Known output declarations describe intact normalized tool values. Program-data
admission rejects an oversized reply rather than substituting a successful
truncation marker. Declarations have
independent size, depth, and traversal bounds; use `describe()` for the original
schema when those bounds require an unknown type. Reading declarations does not
execute tools or automatically enable typechecking of cells.

The contract rules are strict:

- Describe the exact JSON-compatible `details` value, not rendered `content`
  blocks or a provider envelope.
- Include every non-throwing success or error variant. Omit `outputSchema` when
  the tool has no stable structured result.
- Close object layers with `{ additionalProperties: false }` for a complete
  quick-index hint. Open, oversized, or otherwise partial schemas stay
  available through handle `describe()` but do not enable one-turn field use.
- OpenClaw compiles the schema before running the tool, then validates final
  `details` after normal tool hooks and before a catalog call returns. An
  invalid schema cannot run the tool; a mismatch fails without printing the
  value.
- Compact hints are deterministic and bounded. Handle `describe()` exposes
  the full trusted schema when the compact hint is insufficient.
- Installed plugin code is already trusted local code. Remote MCP and client
  metadata remains untrusted and cannot opt into these quick-index hints.

See [Tool plugins](/plugins/tool-plugins#output-contracts) for plugin authoring
details.

MCP catalog entries are not exposed as bare globals or through generic
`catalog` discovery; they are available only through the generated `MCP`
namespace. TypeScript-style declaration files
are available through the read-only `API` virtual file surface, so agents can
inspect MCP signatures without adding MCP schemas to the prompt:

```typescript
const files = await API.list("mcp");
const githubApi = await API.read("mcp/github.d.ts");

const issue = await MCP.github.createIssue({
  owner: "openclaw",
  repo: "openclaw",
  title: "Investigate gateway logs",
});

const snapshot = await MCP.chromeDevtools.takeSnapshot({ output: "markdown" });
const resource = await MCP.docs.resources.read({ uri: "memo://one" });
const prompt = await MCP.docs.prompts.get({
  name: "brief",
  arguments: { topic: "release" },
});
```

`API.read("mcp/<server>.d.ts")` returns compact declarations inferred from MCP
tool metadata:

```typescript
interface McpToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface McpResourcesListResult {
  resources: unknown[];
  nextCursor?: string;
}
interface McpResourcesReadResult {
  contents: unknown[];
}
interface McpPromptsListResult {
  prompts: unknown[];
  nextCursor?: string;
}
interface McpPromptsGetResult {
  messages: unknown[];
  description?: string;
}

declare namespace MCP.github {
  /** Return this TypeScript-style API header. */
  function $api(toolName?: string, options?: { schema?: boolean }): Promise<McpApiHeader>;

  /**
   * Create a GitHub issue.
   * @param owner Repository owner
   * @param repo Repository name
   * @param title Issue title
   */
  function createIssue(input: {
    owner: string;
    repo: string;
    title: string;
    body?: string;
  }): Promise<McpToolResult>;
}
```

Dictionary inputs retain their value types. Nullable enums and fields marked
`nullable: true` include `null`, unless an explicit enum excludes it.
Top-level fields with defaults may be omitted from calls.
These declarations approximate JSON Schema; for constraints that TypeScript
cannot express, inspect the original schema with
`MCP.<server>.$api("<tool>", { schema: true })`.

MCP tool calls return their original JSON-safe content blocks, including block
annotations and block-level `_meta`, plus top-level `structuredContent` and
`isError` when provided. Top-level MCP `_meta` and private app metadata never
enter the guest. An MCP application failure with `isError: true` still resolves
as a result, so guest code can inspect and recover from it. Resource and prompt
operations instead return their native MCP shapes: `resources.list()` returns
`resources`, `resources.read()` returns `contents`, `prompts.list()` returns
`prompts`, and `prompts.get()` returns `messages` with an optional `description`.

Declaration files are virtual, not written under the workspace or state
directory. For each code-mode `exec` call, OpenClaw builds the run-scoped tool
catalog, keeps the visible MCP entries, renders `mcp/index.d.ts` plus one
`mcp/<server>.d.ts` per visible server, and injects that small read-only table
into the QuickJS worker. Guest code sees only the `API` object:
`API.list(prefix?)` returns file metadata and `API.read(path)` returns the
selected declaration content. Unknown paths and `.`/`..` segments are
rejected.

This keeps large MCP schemas out of the model prompt: the agent learns the
virtual API exists from the `exec` tool description, reads only the needed
declaration file, then calls `MCP.<server>.<tool>()` with one object argument.
`MCP.<server>.$api()` remains available as an inline fallback for a
single-tool schema response inside the program.

The guest runtime never sees host objects directly. Inputs and outputs cross
the bridge as JSON-compatible values with explicit size caps.

## Output API

- `text(value)` appends human-readable output to the `output` array.
- `json(value)` appends a structured output item after JSON-compatible
  serialization.
- The guest code's final returned value becomes `value` in a `completed`
  result.

```typescript
type CodeModeOutput = { type: "text"; text: string } | { type: "json"; value: unknown };
```

Await async values before emitting them or returning arrays or plain objects that
contain them. Unawaited Promises appear as a diagnostic string with `await` and
`Promise.all` guidance. For example, use
`return await Promise.all(handles.map((tool) => tool.describe()));` to return tool
descriptions. Output serialization does not await nested Promises for you.

Handled `Error` values retain their `name`, `message`, and JSON-compatible
enumerable custom fields in `text(...)`, `json(...)`, and returned arrays or
plain objects. Error-specific `toJSON` methods are not invoked. This includes
rejected reasons from `Promise.allSettled(...)`. Handling an error does not fail
the cell; uncaught errors still produce a failed result.

Nested tool data and model-visible output have separate limits. A successful
bridge reply reaches the guest as its complete normalized JSON value, or its
promise rejects with a catchable program-data resource error. The transport
never substitutes a successful truncation marker. This also applies to catalog
discovery and whole applicable skill instructions: intact or explicitly refused.

Each cell has an aggregate pending-reply inbox of
`min(memoryLimitBytes, maxSnapshotBytes)` encoded UTF-8 bytes: 10 MiB by default,
up to 256 MiB under the existing configuration clamps. Successful values and
bounded tool errors consume this allowance when they settle, before retention.
The allowance spans inline execution and every wait; it is reusable after the
host and worker release delivered replies, not a cumulative pagination quota.
On saturation, a fixed, bounded failure diagnostic remains available without
retaining tool data; these control replies are bounded by pending-call slots.
Cancellation and expiry close admission and release undelivered replies.

This is an additional logical host-data allowance, not a total RSS limit or a
guarantee that large data can be suspended. Guest heap and whole-VM snapshot
limits remain unchanged; worker handoff and JSON conversion can temporarily
retain additional copies. Narrow or paginate requests after an admission error.

Output order matches guest calls. Cumulative guest output and the final value
or failure diagnostic still share one `maxOutputBytes` serialized UTF-8 budget
across all waits. Oversized errors retain their leading cause and end with
`[error truncated]`; truncation does not turn a failure into success. For
successful emitted or returned output that exceeds this budget, OpenClaw returns a bounded value
with `truncated: true`, a UTF-8-safe `prefix`, `omittedBytes`, and guidance to
rerun with narrower arguments. Treat that marker as a successful partial result:
reduce the search scope, paginate, select fewer files, or return a smaller
projection. Non-serializable values are converted to plain strings or errors;
binary values are not supported. Images and files travel through ordinary
OpenClaw tools, not through the code-mode bridge.

Marker prefixes and omitted-byte counts describe the original compact JSON after
normalization, including array brackets, separators, and JSON escaping. Ordinary
output is delivered incrementally. An unchanged cumulative summary is not repeated;
new output or a changed final-value/error reservation can produce a replacement
summary of that same original output.

Model-facing `exec` and `wait` results also fit the effective model's per-result
context and persistence limits. OpenClaw reserves the complete result envelope,
including status, continuation, diagnostics, telemetry, and JSON formatting,
using the same compact representation for budget fitting and delivery before
projecting output from its retained original source. Network-derived
results retain the untrusted-content wrapper and its smaller content limit.
These limits do not reduce the nested tool's byte allowance. Headless execution
and low-level controls without model context retain their byte-only allowance
(with the existing security wrapper limit for network-derived control output).

This protects fresh results; it is not an archival JSON guarantee. Later
aggregate reduction, cache-TTL pruning, and replay into a smaller model may
still shorten or replace historical tool text. Already-sent results stay
unchanged during ordinary continuation. Conventional tools keep their own text
and image formats: a declared output schema describes `details`, not model-visible
text. The file-read producer reserves its exact paging footer within the same
model limits, and oversized skill instructions are refused rather than silently
served in part.
