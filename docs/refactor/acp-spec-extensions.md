# RFC: ACP spec extensions

> **SUPERSEDED (2026-04-23).** This draft predates a comparison against the actual ACP repository, in-flight RFDs, and core-maintainer meeting notes. After that comparison most of the proposals here were found to already be implemented (`ExtRequest` / `ExtNotification` / `_meta`), already in-flight as dedicated RFDs (`auth-methods`, `session-close`, `session-resume`, `session-usage`, `message-id`, `meta-propagation`, `proxy-chains`, `elicitation`, `additional-directories`, `boolean-config-option`, `custom-llm-endpoint`, `request-cancellation`, `mcp-over-acp`, `streamable-http-websocket-transport`, `session-fork`, `session-delete`, `logout-method`, `next-edit-suggestions`, `agent-telemetry-export`), or planned by core maintainers (better subagent representation, notification-based prompt format, plan mode improvements). Keeping two parallel multi-track proposals alive would have contributed to spec fragmentation rather than prevented it.
>
> Replaced by **[`acp-rfd-sandbox-capability-policy.mdx`](./acp-rfd-sandbox-capability-policy.mdx)**, a single focused RFD scoped to the one area that was not already being addressed: typed sandbox capability/policy modeling. That doc also carries the brief "how OpenClaw will consume adjacent in-flight RFDs" summary so reviewers can see the wider context.
>
> The content below is preserved for traceability but should not be taken as a proposal.

**Status.** Draft for upstream proposal to [agentclientprotocol.com](https://agentclientprotocol.com/) maintainers.
**Authored in.** `openclaw/openclaw` — authored here because the motivation emerged from the ACP-everywhere consolidation work (`docs/refactor/acp-everywhere.md`), but the proposal itself is protocol-level and not OpenClaw-specific.
**Scope.** Two tracks:

- **Track A — Spec completeness.** Tighten ACP around gaps every consumer of the protocol feels once they try to drive a full coding-agent harness through it. Promote already-advertised tags to first-class variants, structure the tool-call lifecycle, formalize approval/compaction/lifecycle/correlation, and replace the boolean sandbox model with a typed capability/policy split.
- **Track B — Foundational extension mechanism.** Add a small set of meta primitives (namespaced extensions, custom event variants, client method extensions, structured context bundles, session metadata) that let individual implementers carry their domain-specific needs through the protocol _without_ forking it. The goal is: once these primitives exist, no one ever has to modify the core spec just to thread their own state through.

## Non-goals

- Replacing JSON-RPC 2.0, the ACP handshake, or the stdio/socket transports.
- Changing the session lifecycle primitives (`newSession`, `loadSession`, `setMode`, `setConfigOption`, `cancel`, `close`, `doctor`).
- Mandating any particular backend architecture.
- Adding domain-specific (e.g. messaging, memory, skills) vocabulary into core ACP. Those belong in extension namespaces (Track B).

# Track A — Spec completeness

## A1. First-class event variants for already-advertised tags

**Problem.** The current `AcpSessionUpdateTag` / `AcpRuntimeEvent` landscape advertises a number of update types as _tags_ on loose events but does not model them as typed variants: `agent_thought_chunk`, `tool_call_update`, `usage_update`, `plan`, `current_mode_update`, `config_option_update`, `session_info_update`, `available_commands_update`. Consumers that want to pattern-match safely have to string-compare, which loses type-checker help and leaves the shape of each event's payload undocumented.

**Proposal.** Promote each of these to a typed variant of the session update / runtime event stream with a stable payload shape:

```ts
type AcpRuntimeEvent =
  | { type: "agent_message_chunk"; text: string }           // already effectively covered
  | { type: "agent_thought_chunk"; text: string }           // NEW (promoted)
  | { type: "tool_call"; ... }                              // see A2
  | { type: "tool_call_update"; ... }                       // see A2
  | { type: "usage_update"; usage: UsageCounters }          // NEW (promoted)
  | { type: "plan_update"; plan: Plan }                     // NEW (promoted)
  | { type: "current_mode_update"; mode: string }           // NEW (promoted)
  | { type: "config_option_update"; key: string; value: unknown } // NEW (promoted)
  | { type: "session_info_update"; info: SessionInfoSummary }     // NEW (promoted)
  | { type: "available_commands_update"; commands: Command[] }    // NEW (promoted)
  | { type: "lifecycle"; phase: "start" | "end" | "error"; ... }  // see A4
  | { type: "compaction"; phase: "start" | "progress" | "end"; ... } // see A5
  | { type: "approval_request"; ... } | { type: "approval_response"; ... } // see A3
  | { type: "status"; ... }
  | { type: "done"; stopReason?: string }
  | { type: "error"; message: string; code?: string; retryable?: boolean };
```

Keep tags around for backward compatibility; new variants are additive.

**Impact.** Any ACP client / agent benefits: stable types, type-checked handlers, clean pattern match.

## A2. Structured tool-call lifecycle

**Problem.** Today's `tool_call` is flat and conflates start / update / end. It does not model: structured arguments, structured results, intermediate progress, or canonical phases. Real coding harnesses emit tool work in three distinct phases and consumers need all three.

**Proposal.** Split into two variants with a shared `toolCallId`:

```ts
type ToolCallStart = {
  type: "tool_call";
  toolCallId: string;
  title?: string;
  kind?: string; // treat as untrusted hint
  args?: unknown; // structured, per-tool schema
};

type ToolCallUpdate = {
  type: "tool_call_update";
  toolCallId: string;
  phase: "progress" | "end";
  status?: "running" | "succeeded" | "failed" | "cancelled";
  text?: string; // incremental output chunk (progress)
  content?: ToolCallContent[]; // structured content (end)
  result?: unknown; // structured result payload (end)
  error?: { message: string; code?: string };
  locations?: FileLocation[]; // files the tool touched, if known
};
```

**Impact.** Consumers get a clean start/progress/end state machine per tool call without having to infer from flat tags.

## A3. Formal approval request/response events

**Problem.** ACP has a permissions concept but approval flow is not modeled as events on the turn stream. Non-interactive consumers (headless bridges, IDE automations) need a uniform way to intercept, log, and answer approval prompts.

**Proposal.** Add two event variants:

```ts
type ApprovalRequest = {
  type: "approval_request";
  approvalId: string;
  operation: "fs.write" | "fs.delete" | "exec" | "net" | string; // extensible
  subject: string; // human-readable summary
  details?: unknown; // operation-specific payload
  defaultDecision?: "allow" | "deny";
  timeoutMs?: number;
};

type ApprovalResponse = {
  type: "approval_response";
  approvalId: string;
  decision: "allow" | "deny";
  scope?: "once" | "session" | "always";
  by?: "user" | "policy" | "timeout";
};
```

Clients may also reply via an ACP request method (`session/approve`) instead of a streamed response, for symmetry with the existing permissions flow.

**Impact.** Headless / bridged consumers get first-class approval handling; interactive clients can keep their current permission flow.

## A4. Lifecycle variants

**Problem.** `done` and `error` exist but there is no `start` or in-run phase marker. Observability tools (tracers, correlation, progress UIs) need a canonical `start` event with the run id.

**Proposal.**

```ts
type Lifecycle =
  | {
      type: "lifecycle";
      phase: "start";
      requestId: string;
      startedAt: number;
      meta?: Record<string, unknown>;
    }
  | { type: "lifecycle"; phase: "end"; requestId: string; endedAt: number; stopReason?: string }
  | {
      type: "lifecycle";
      phase: "error";
      requestId: string;
      endedAt: number;
      error: { message: string; code?: string };
    };
```

`done` / `error` remain as terminal events. `lifecycle` is additive and can be emitted alongside them.

## A5. Compaction events

**Problem.** Every mature agent backend compacts conversation state at some point; consumers currently have no way to tell the difference between "working on the turn" and "compacting and about to retry." Observability and UX around long runs suffers.

**Proposal.**

```ts
type Compaction =
  | { type: "compaction"; phase: "start"; reason?: string; estimateMs?: number }
  | { type: "compaction"; phase: "progress"; used?: number; size?: number; note?: string }
  | {
      type: "compaction";
      phase: "end";
      retry?: boolean;
      newContextSize?: number;
      droppedTurns?: number;
    };
```

Backends that don't compact simply never emit these. Clients that don't care can ignore them.

## A6. Per-event `requestId` echo

**Problem.** Turn events today carry no stable correlation token. Consumers that need to correlate logs / metrics / transcripts to a specific turn have to rely on the outer iterator identity, which doesn't survive serialization, logging, or multiplexing.

**Proposal.** Every variant of the session update / runtime event stream carries an optional `requestId: string` field. Backends SHOULD populate it with the `requestId` from the originating `session/prompt`. Consumers MAY ignore it.

**Impact.** Trivial for backends; significant quality-of-life for anyone writing a multiplexer, a proxy, a replay tool, or an audit sink.

## A7. Sandbox capability and policy split

**Problem.** There is no first-class way in ACP today to describe what isolation a backend offers or what isolation a particular run requires. Implementers end up bolting on booleans (`runsInSandbox`), which can't express grade (host / chroot / container / seccomp) or dimension (filesystem / network / process caps). Worse, "what the backend can enforce" and "what the operator requested" get blurred into one field.

**Proposal.** Two distinct types, and a predicate:

```ts
// Backend-advertised (static). Returned from getCapabilities.
type SandboxCapability = {
  mode: "host" | "docker" | "podman" | "chroot" | "seccomp" | "custom";
  guarantees: {
    fsIsolation: "none" | "workspace" | "fullRoot";
    netIsolation: "none" | "restricted" | "denyAll";
    processCaps: boolean;
  };
};

// Per-run request (dynamic). Optional field on ensureSession input.
type SandboxPolicy = {
  require: "any" | "host" | "sandboxed";
  minFsIsolation?: "workspace" | "fullRoot";
  minNetIsolation?: "restricted" | "denyAll";
  image?: string;
  setupCommand?: string;
};

// The client checks satisfies(capability, policy) before using the session
// for a run whose policy demands sandboxing.
function satisfies(capability: SandboxCapability, policy: SandboxPolicy): boolean;
```

Hosting a boolean is fine as a trivial case (`capability.mode === "host"` means "no sandbox"), but the shape leaves room for future stronger isolation.

**Impact.** Backends can advertise real isolation grades; clients can make real policy decisions; operators stop seeing errors like "sandbox=require unsupported" without any diagnostic path.

# Track B — Foundational extension mechanism

The goal of Track B is that an implementer (OpenClaw, an IDE, a new harness, a third-party plugin author) can add their domain-specific needs — new event types, new ensureSession inputs, new client-side methods, new session state — without forking the protocol and without inflating the core spec. Existing ACP has `_meta` at the message level but no clean primitives for the other axes.

## B1. Extension packages and namespaces

**Proposal.** Formalize extensions as named, versioned packages. Each extension gets a reverse-DNS namespace:

```ts
type ExtensionId = string; // e.g. "com.openclaw.messaging"
type ExtensionVersion = string; // semver

type ExtensionCapability = {
  id: ExtensionId;
  version: ExtensionVersion;
  methods?: string[]; // method namespaces this extension adds
  eventTypes?: string[]; // event `type` values this extension emits
  configOptionKeys?: string[]; // setConfigOption keys this extension reads
  ensureSessionFields?: string[]; // optional ensureSession fields this extension consumes
  clientMethods?: string[]; // client-side method namespaces the backend expects
};
```

Backends advertise supported extensions via `getCapabilities().extensions: ExtensionCapability[]`. Clients advertise the extensions they offer similarly in `initialize`. The intersection is the set both ends may use.

**Impact.** Extensions become discoverable, versioned, and composable. A backend that doesn't know an extension ignores its events and inputs; a client that doesn't support an extension simply doesn't advertise its client methods.

## B2. Generic custom event variants

**Proposal.** Add a typed custom-event variant to the session update / runtime event stream:

```ts
type CustomEvent = {
  type: "custom";
  extension: ExtensionId;
  event: string; // extension-local event name
  payload?: unknown; // schema is extension-defined
  requestId?: string;
};
```

Backends that need to emit extension-specific events do so under `custom` with an `extension` namespace. Consumers that don't recognize the extension simply discard the event. No spec change is needed to add a new event type.

**Impact.** No more "please add an event variant for my use case" pressure on the core spec. Examples: OpenClaw's channel-delivery notifications, a memory-plugin's recall-hit events, an IDE's custom diff-preview events.

## B3. Client method extensions

**Problem.** ACP already supports client-side method namespaces like `fs/*`, `terminal/*`, approval prompts. There's no general mechanism to advertise a new namespace, so every new one (messaging, memory, secrets, notifications, ...) would require a spec change.

**Proposal.** Allow clients to advertise additional JSON-RPC method namespaces at `initialize` time, each tagged with an extension id:

```ts
type ClientExtensionMethods = {
  extension: ExtensionId;
  methods: string[]; // e.g. ["messaging/send", "messaging/typing"]
};

type InitializeResult = {
  // ... existing fields ...
  clientExtensionMethods?: ClientExtensionMethods[];
};
```

Backends then call these methods by their fully-qualified name over the standard ACP JSON-RPC transport. The semantics of each method are extension-defined.

**Impact.** New client-side capability families (messaging, memory, secrets, telemetry, ...) can be added without touching the core protocol. Exactly the mechanism ACP already uses for `fs/*` and `terminal/*`, just made explicit.

## B4. Named structured context bundles

**Problem.** Different harnesses need different structured preamble at session setup: Codex reads `model_instructions_file`; Claude Code reads plugin directories; agents may want skill catalogs, bootstrap contexts, rule files, custom system prompt fragments. Ad-hoc per-backend flags multiply.

**Proposal.** Add an optional typed bag on `ensureSession`:

```ts
type ContextBundle = {
  kind: string; // extension-qualified id, e.g. "com.openclaw.skills"
  version?: string;
  encoding?: "json" | "text" | "base64";
  payload: unknown; // schema determined by kind
};

type EnsureSessionInput = {
  // ... existing fields ...
  contextBundles?: ContextBundle[];
};
```

Backends accept only the `kind`s they advertise in their `ExtensionCapability.ensureSessionFields`. Unknown `kind`s are ignored (or rejected, per capability) rather than causing failure.

**Impact.** Any harness can carry structured initial context through the protocol using a single generic mechanism, rather than lobbying the spec for a new `skills` / `rules` / `plugins` field each time.

## B5. Session metadata bag

**Problem.** Clients often need to attach bookkeeping to a session that survives `loadSession` but is not part of the conversation. Today they have to serialize/deserialize out-of-band.

**Proposal.** Optional `metadata: Record<string, unknown>` on the session that:

- Is opaque to the backend (backends MUST round-trip it unchanged through `loadSession`).
- Is namespaced by convention (`com.openclaw.bindingRecord`, `com.vendor.trace`, etc.).
- Has a size cap declared by the backend via capabilities.

**Impact.** Clients stop having to maintain parallel session stores just for extension-specific per-session state.

## B6. Extension-scoped config options

**Problem.** `setConfigOption(key, value)` is a flat string key space. Collisions between extensions and core are a matter of convention, not spec.

**Proposal.** Encourage (and in capability advertisement, require) extension keys to be namespaced:

```
setConfigOption("com.openclaw.fastMode", true)
setConfigOption("com.openclaw.elevatedActions", "owner-only")
setConfigOption("model", "openai/gpt-5.4")           // core key, unnamespaced
```

Backends list their accepted keys in `ExtensionCapability.configOptionKeys`. Unknown keys return an error code distinguishable from "known key, bad value" (add `"config_option_unknown"` error code).

**Impact.** Stable boundary between core config (model, temperature, approval policy, timeout) and extension config (fast mode, elevated actions, cache hints, experimental toggles). No string-space collisions across ecosystems.

# How the two tracks combine

Applied together, Tracks A and B give the protocol:

- A richer, fully-typed core event stream (A1–A6) so type-safe clients stop losing information.
- A real sandbox model (A7) so policy decisions stop being boolean vibes.
- Clean extension primitives (B1–B6) so no one needs to ever propose another domain-specific addition to the core spec.

A concrete example of the two tracks in concert: OpenClaw's messaging-context need (an open row on our internal richness audit) lands entirely in Track B — a `com.openclaw.messaging` extension that advertises client methods (`messaging/send`, `messaging/typing`), uses a `custom` event for delivery notifications, and stores thread-binding records in the session metadata bag. No changes to core ACP beyond the Track B primitives, which themselves are domain-neutral.

# Rationale and alternatives

## Why not just use `_meta` for everything?

`_meta` at the message level is a loose escape hatch. It does not:

- Discover or version extensions.
- Carry typed event payloads.
- Gate acceptance by capability.
- Give clients a legal way to add new method namespaces.

The extension mechanism in Track B makes extensions first-class citizens instead of free-text stowaways.

## Why not vendor each harness's needs into core?

Core bloat, naming fights, and slower evolution. Different backends (IDE-embedded vs. channel-relay vs. CI runner vs. GPU-bound harness) have different legitimate extensions; folding any of them into core privileges one category and penalizes the others. The foundational extension mechanism lets each category flourish without dragging the core spec along.

## Why structured sandbox types now?

Because boolean sandbox is already getting reinvented on top of `_meta` and `setConfigOption` by multiple implementers. Standardizing the capability/policy split early prevents three separate incompatible "sandbox" conventions emerging in parallel.

## Why promote tags to variants rather than just publishing the tag vocabulary?

Tags are stringly-typed and don't carry payload schemas. A consumer that sees `tag: "usage_update"` has to hope the rest of the event is shaped right. First-class variants make the shape legal and checkable.

# Backwards compatibility

- Tag-based events (A1) continue to work; variants are additive.
- Existing `tool_call` shape (A2) remains valid; a backend that never emits `tool_call_update` is still conformant.
- Approval via ACP's existing permissions flow (A3) remains valid; the event form is an alternative, not a replacement.
- `lifecycle` / `compaction` (A4, A5) events are additive; backends that don't emit them are unchanged.
- `requestId` echo (A6) is optional on the backend side; consumers that don't use it are unchanged.
- Backends that don't opt into `SandboxCapability` (A7) keep today's implicit "host-only" behavior.
- All Track B primitives are pure additions; backends and clients that don't opt into extensions are unaffected.

No existing ACP deployment should break on adopting these extensions; the upgrade path is version-negotiated at `initialize` / `getCapabilities`.

# Unresolved questions

- Should `custom` events (B2) count as "session updates" for the purpose of `loadSession` replay, or be ephemeral by default? Suggest: ephemeral by default, with an extension capability flag `replayable: true` for extensions that want persistence.
- Should `ContextBundle` payloads (B4) be size-capped at the protocol level or left to backend advertisement? Suggest: advertised cap per `kind`, with a core-spec recommended default.
- Should approval flow (A3) be fully unified with ACP's existing permissions, or kept as a parallel event-based path? Suggest: unify, and deprecate the older shape in a minor version.
- Is `requestId` the right name for per-event correlation, or should we pick something more neutral (`turnId`, `correlationId`)? Suggest: `requestId` for continuity with existing `TurnInput.requestId`.

# Prior art

- JSON-RPC 2.0 batch and notifications: the "ignore unknown" semantics we lean on.
- Language Server Protocol `InitializeParams.capabilities` and `clientInfo` / `serverInfo` version negotiation.
- Model Context Protocol (MCP) `serverCapabilities` / `clientCapabilities` — similar shape; ACP's extension advertisement should feel familiar to anyone who has implemented an MCP server.
- OpenTelemetry resource / attribute semantic-conventions: the namespacing and extensibility pattern.
- xumux-ACP (`https://github.com/deftai/xumux/blob/openmux/docs/ext-acp-agent-client-protocol.md`) for the "same ACP payloads over arbitrary transports" idea — supports the claim that the protocol surface is worth keeping clean and wire-agnostic.

# Future possibilities

- Conformance test suite that validates both core spec and any advertised extension (backend + client sides).
- Extension registry so reverse-DNS ids don't collide across ecosystems (similar to MIME type assignments).
- Per-extension semver compatibility policy so `com.openclaw.messaging@1.x` and `@2.x` can coexist cleanly.

# What this does and doesn't enable for OpenClaw

This RFC is not OpenClaw-specific. That said, within OpenClaw's concurrent `acp-everywhere` consolidation work (`docs/refactor/acp-everywhere.md`, `docs/refactor/acp-everywhere-richness-audit.md`), adopting Tracks A and B upstream would turn roughly 80% of our audit's 🟡 rows into pure spec-completeness wins rather than OpenClaw-flavored extensions, and the remaining 20% into clean Track B extensions carried under `com.openclaw.*` namespaces without core-protocol churn. That's the strategic case for proposing these upstream instead of building them as OpenClaw-only extensions.
