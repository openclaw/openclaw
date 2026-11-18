---
summary: "Continue an upstream W3C trace through the Gateway WebSocket, and control what content leaves the process"
title: "Privacy and trace context"
sidebarTitle: "Privacy and trace context"
read_when:
  - You want one OpenTelemetry trace per dataset item to cover the matching OpenClaw execution
  - You need to know exactly what prompt, response, or tool content is exported
  - You are approving `captureContent` against a retention policy
---

## Continue an upstream WebSocket trace

An authenticated Gateway WebSocket client can attach a W3C `traceparent` to
each request frame:

```json
{
  "type": "req",
  "id": "eval-item-42",
  "method": "agent",
  "params": {},
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
}
```

The Gateway creates a child request context that preserves the upstream trace
ID and sampling flags. Agent, harness, model-call, provider, tool-execution, and
exec spans created inside the request remain on that trace, including spans
recorded after their parent run has already finished. This allows a local
experiment runner to create one Langfuse/OpenTelemetry trace per dataset item and
correlate the corresponding OpenClaw execution.

Trace context is request-scoped, not connection-scoped. On a long-lived
WebSocket, generate or inject the appropriate `traceparent` independently for
every RPC. Concurrent requests remain isolated even when their work
interleaves.

The field is accepted only after the existing Gateway authentication handshake
and does not affect authentication or method authorization. A `traceparent` on
the initial `connect` frame is ignored. Missing or syntactically malformed
values within the 128-character field limit silently fall back to a fresh
request trace; longer values make the request frame invalid. `tracestate` and
`baggage` are not accepted by the Gateway WebSocket protocol.

## Privacy and content capture

Raw model/tool content is **not** exported by default. Spans carry bounded
attributes such as channel, provider, model, error category, hash-only request
IDs, tool source, tool owner, and skill name/source. Without content capture,
spans do not include prompt text, response text, tool inputs, tool outputs, or
skill file paths. Spans never include raw session keys. Session and message
origin identifiers have separate capture controls described below. Values that
look like scoped agent session keys (for example starting with `agent:`) are
replaced with `unknown` on low-cardinality attributes. OTLP log
records keep severity, logger, available code locations, trusted trace context, and
sanitized attributes by default; the raw log message body is exported only
when `diagnostics.otel.captureContent` is `true`. Subsystem `info` records omit code
locations to avoid capturing a stack for each routine message. Talk metrics export only
bounded event metadata (mode, transport, provider, event type) - no
transcripts, audio payloads, session ids, turn ids, call ids, room ids, or
handoff tokens.

## Session identity

Trace backends can group spans into conversations by session ID. To export this
ID without content, set `diagnostics.otel.captureSessionIdentity` to `true`.
When unset, this setting follows `diagnostics.otel.captureContent` for
compatibility. Set it to `false` to disable session ID export even when content
capture is on. With session identity capture enabled, run-scoped spans (run,
message and prompt processing, model call, model usage, harness, tool execution,
and skill use) carry:

- `gen_ai.conversation.id`: the GenAI semantic-conventions attribute that
  Langfuse, LangWatch, Phoenix, and other vendor-neutral backends read for
  grouping, valued with the session id.
- `openclaw.session.id`: the same session id under the OpenClaw-native key.

The value is the session id — the durable identifier OpenClaw assigns at
session creation, not the session key — so backends group turns with the same
session ID into one conversation. A `/new` reset normally preserves the durable
session ID; ACP session resets rotate it. A fresh session also receives a new ID.
The raw session key can embed channel peer IDs and is never exported. Session
IDs remain stable identifiers of a conversation, not anonymous values. Approve
the collector and its retention policy for identifiers before enabling capture.
Metric attributes never carry session identifiers.

## Message origin

Set `diagnostics.otel.captureMessageOrigin` to `true` to export a native message
origin without content capture. The setting defaults to off, even when content
capture is on. For Slack turns, `openclaw.message.processed` and `openclaw.run`
spans can include `openclaw.origin.channel.id`. Its value identifies the current
turn's native Slack channel or direct-message conversation, not the session ID.
Other channel integrations do not supply this attribute. Model, tool, and
harness spans do not inherit it from their parent spans. Generic CLI backends
other than Claude CLI do not currently emit an `openclaw.run` span; the message
span can still carry the origin when available. Slack slash commands do not yet
supply this diagnostic origin. Built-in restricted finalization run spans omit it.

OpenClaw omits the attribute when the native origin is missing, unsuitable, or
ambiguous, including a collected batch with mixed origins. The identifier must
contain 1 to 128 printable ASCII characters without spaces. The exporter applies
sensitive-text redaction to the identifier. Origin IDs never label metrics or
appear in public diagnostic event payloads. Trusted diagnostic listeners that
request private data can receive the origin ID. A Slack ID can identify a
conversation, so approve the collector and retention policy for this data.
Traces can be sampled or lost and are not a complete audit trail.

## Other trace data

Skill-use spans can include a SHA-256 fingerprint of the instructions actually
delivered while tracing is active, even with content capture disabled. This
allows correlation of identical instruction bodies and comparison with known
content; it is not anonymization. OpenClaw does not hash unread support files or
the discovered skill catalog for this attribute, and does not export the body
or file path. Metrics-only exporters do not request this hashing.

When `diagnostics-otel` tracing is active, outbound model requests may include
a W3C `traceparent` header from the actual exporter-owned model-call span.
Diagnostic trace IDs and span IDs only correlate events to that span; they are
not used as outbound OTel identities. If the exporter cannot resolve a real
span context, OpenClaw omits the header instead of naming an unexported parent.
Existing caller-supplied `traceparent` headers are removed or replaced, so
plugins or custom provider options cannot spoof cross-service trace ancestry.

Set `diagnostics.otel.captureContent` to `true` only when your collector and
retention policy are approved for prompt, response, tool, and tool-definition
text. This enables bounded, redacted input messages, output messages, tool
inputs, tool outputs, tool definitions, and OTLP log bodies. System prompts
remain excluded. Provider-internal `thinking` and `redacted_thinking` payloads
are also excluded: compatibility attributes retain only a redacted structural
marker, while GenAI message attributes omit those parts. Inline image data
longer than 128 KiB, which no attribute could carry whole, is dropped from
model input and output messages; the image part and its MIME type remain.
Serialized JSON over 512 KiB goes directly through bounded truncation rather
than attempting to fit the whole value after redaction. Every retained string
is still redacted before truncation.

The same setting also exports the bounded, redacted turn prompt and the model's
final answer as `input.value` and `output.value` on `openclaw.message.processed`,
`openclaw.harness.run`, and `openclaw.run` spans. Operators who already enable
`captureContent` receive these attributes after upgrading; see the
[upgrade note](/gateway/opentelemetry/spans-and-events).

Completed assistant commentary uses the same setting. With content capture
off, commentary events contain timing, sequence, harness, and text-length
metadata only. With it on, each event can include up to 16,384 characters of
visible commentary through the existing redacted output-message attributes.
Commentary text never enters ordinary diagnostic logs or public diagnostic
events.

`toolInputs`/`toolOutputs` content is captured for the built-in agent
runtime's tool executions (`openclaw.content.tool_input` and
`gen_ai.tool.call.arguments` on completed/error spans;
`openclaw.content.tool_output` and `gen_ai.tool.call.result` on completed
spans). The `openclaw.content.*` names remain the stable OpenClaw attribute
names; the `gen_ai.tool.call.*` copies mirror them for semconv-native viewers.
External harness tool calls (Codex, Claude CLI) emit
`tool.execution.*` spans without content payloads. Captured content travels on a
trusted, listener-only channel and is never placed on the public diagnostic event
bus.
