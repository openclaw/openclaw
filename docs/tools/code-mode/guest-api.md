---
summary: "Globals, catalog handles, MCP namespaces, and virtual API declarations inside guest code"
title: "Code Mode guest API"
read_when:
  - You are writing or reviewing guest JavaScript for Code Mode
  - You are reviewing the MCP namespace bridge or virtual API declarations
  - You need to read paginated file data from guest code
---

## Guest runtime API

```typescript
declare const catalog: ToolCatalog;
declare const MCP: Record<string, unknown>;
declare const namespaces: Record<string, unknown>;

declare function setTimeout(
  callback: (...args: unknown[]) => void,
  delay?: number,
  ...args: unknown[]
): number;
declare function clearTimeout(id: number): void;
declare function text(value: unknown): void;
declare function json(value: unknown): void;
declare function yield_control(reason?: string): Promise<void>;
```

`TextEncoder` and `TextDecoder` are available for local text and byte transforms.
Encoder and decoder instances survive `wait` snapshot restoration. They run
inside the QuickJS sandbox and grant no filesystem, module, or network access.
Returned values still use the JSON-only bridge; emit decoded text or an array of
byte values rather than a binary attachment.

`console.log`, `console.info`, `console.warn`, `console.error`, and
`console.debug` emit diagnostic text through the same ordered output channel as
`text` and `json`, not through host logs. They return `undefined`;
`console.error` does not throw. Non-log methods prefix their message with the
level, such as `[warn]`. Arguments are separated by spaces; printf-style tokens
like `%s` stay literal. Other Console API methods are not provided.

Console inspection is intentionally bounded rather than a Node/browser console
emulation. Strings are unquoted; objects and arrays use compact JSON-shaped
inspection of enumerable own properties, with an Error's own message included.
It does not invoke getters or custom `toJSON` methods. Cycles, accessors,
unawaited promises, and inspection failures get diagnostic placeholders. Each
call visits at most 100 values, 50 properties per object, and four object levels.
String values and keys retain up to 512 UTF-16 code units; a message retains up
to 4096, plus a truncation suffix, without splitting surrogate pairs.

Across all resumes, console entries have an additional conservative limit of
16,384 serialized JSON UTF-16 code units (less than 49,152 UTF-8 bytes). Once
full, a single `[console output truncated]` entry replaces the next message and
further console calls are ignored. The existing cumulative `maxOutputBytes`
and model-result caps still apply to console output together with `text`,
`json`, and the final value or error. Use explicit `text`/`json` with narrower
inputs when diagnostic inspection is insufficient.

Guest timers are bridged through the host, so they survive QuickJS snapshot/resume and remain bounded by the Code Mode execution and snapshot limits.
`clearTimeout` also cancels a timer created before an earlier suspension; this
applies to interactive Code Mode and headless automation scripts.

Every effective non-MCP tool is also installed as an async global function.
The model-visible `exec` description includes a bounded, deterministic subset
of final callable names, compact input hints, and trusted declared output hints.
Descriptions remain deferred so adversarial catalog prose cannot steer the
model. When that index omits a tool, call `catalog.search(...)`; its results are
callable functions.

The arrow in each quick-index line describes the callable function's value.
`-> Array<{ id: string }>` is a declared output hint; `-> ?` is output unknown.
Unknown outputs stay raw-first: return the value unchanged, observe it, then
filter or map it in a later `exec` instead of feeding guessed fields into
dependent logic in the same program. This also
applies when a declared-output read feeds a final `-> ?` call: return that
call's raw value without wrapping it in the requested answer shape.

```typescript
type ToolCatalogMetadata = {
  callableName: string;
  toolName: string;
  label?: string;
  description: string;
  source: "openclaw" | "client";
  input?: string;
  output?: string;
};

type ToolCatalogHandle = ((input?: unknown) => Promise<unknown>) &
  ToolCatalogMetadata & {
    describe(): Promise<ToolCatalogDescription>;
    toJSON(): ToolCatalogMetadata;
  };
```

Returning `await catalog.search(...)` or `catalog.all()` serializes each
callable handle to this bounded metadata. Serialization does not call
`describe()` or start another bridge request; inside the same program, the
handle remains callable.

`input` is a bounded TypeScript-style signature for the common case. Use
the handle's `describe()` when the exact full schema is still needed. Client
entries use `input: "unknown"` so their untrusted schemas stay deferred until
`describe()`. `output` is
present only for a complete compact hint derived from a trusted OpenClaw core
or plugin `outputSchema`. MCP and client output-schema claims are not promoted
into this trusted catalog hint.

Plugin tools use `source: "openclaw"`; there is no separate `"plugin"` source
value. MCP entries are excluded from generic catalog discovery and remain
available only through `MCP`.

Full schema is loaded only on demand:

```typescript
type ToolCatalogDescription = Omit<ToolCatalogMetadata, "toolName"> & {
  name: string;
  parameters: unknown;
  outputSchema?: unknown;
};
```

Catalog helpers:

```typescript
type ToolCatalog = {
  search(query: string, options?: { limit?: number }): Promise<ToolCatalogHandle[]>;
  all(): readonly ToolCatalogHandle[];
};
```

`catalog.search(...)` returns a frozen array of callable handles, or an empty
array when no tools match. If the matching callable names exceed the available program-data
inbox capacity, search rejects with guidance to narrow the request.
It never silently substitutes an empty or partial match list. A narrower search
remains available after the error.

Paired Gateway nodes are available through the `nodes` global:

```typescript
const available = await nodes.list();
const node = await nodes.get(available[0].id);
const status = await node.invoke("device.status");
```

`nodes.list()` returns paired node ids, names, platforms, connection state, and
advertised commands. `nodes.get(idOrName)` resolves an exact id before a display
name and returns a handle with `id`, `name`, and `invoke(command, params?)`.
Invocation uses the normal `nodes` tool path, so pairing, command policy, scopes,
approvals, timeouts, hooks, and telemetry are unchanged. A handle includes
`listDir(path)` only when the node advertises `fs.listDir`. It does not include
`exec`: the generic nodes surface reserves `system.run` for the normal shell
`exec` tool with a node host.

Call quick-index globals directly, or use callable catalog handles when lookup
is needed:

```typescript
const content = await read({ path: "README.md" });

const [tool] = await catalog.search("...");
const result = await tool({ query: "OpenClaw" });

const [search] = await catalog.search("search the web", { limit: 1 });
const schema = await search.describe();
const hits = await search({ query: "OpenClaw code mode" });
```

Calling a global or catalog handle returns the normal tool's JSON `details`
value directly. Exact catalog ids and raw `{ tool, result }` envelopes are not
guest-visible.

The `ls`, `find`, and `grep` tools include their bounded listing or search text
in `content`, including empty-result messages and truncation notices. Directory
pages retain `nextAfter`; search results retain their existing limit and
truncation metadata.

### Reading paginated file data

For text file pages, `read(...)` returns file text in `content`; filename-resolution
and pagination notices stay in the human-readable tool display, not the structured
file data. Existing file redaction still applies. Check `kind` before parsing:
`"truncated"` means more data is available at `continuation`. Read that next page
with the same path and the returned `offset`, optional `cursor`, and optional
`limit`. Join line continuations with `"\n"`; append cursor continuations directly.
Do not strip display-notice patterns from file data: those strings may be actual
file contents. Each call still honors its explicit `limit`; if more file data
remains, the result is `"truncated"` and its continuation describes the next page.
