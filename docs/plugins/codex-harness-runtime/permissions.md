---
summary: "Native permission decisions, remembered approvals, and MCP elicitation limits"
read_when:
  - You are routing Codex native permission requests through OpenClaw
  - You need the MCP elicitation form and URL limits
title: "Codex native permissions and elicitations"
sidebarTitle: "Permissions and elicitations"
---

How native permission requests and MCP elicitations reach the OpenClaw approval flow. Part of the [Codex harness runtime](/plugins/codex-harness-runtime) guide; [Where each section moved](/plugins/codex-harness-runtime#where-each-section-moved) lists every section.

## Native permissions and MCP elicitations

For `PermissionRequest`, OpenClaw only returns explicit allow or deny
decisions when policy decides. A no-decision result is not an allow: Codex
treats it as no hook decision and falls through to its own guardian or user
approval path.

Codex app-server approval modes omit this native hook by default. This
applies unless `permission_request` is explicitly included in
`nativeHookRelay.events` or a compatibility runtime installs it.

When an operator chooses `allow-always` for a Codex native permission
request, OpenClaw remembers that exact provider/session/tool input/cwd
fingerprint for a bounded session window. The remembered decision is
intentionally exact-match only: a changed command, arguments, tool payload, or
cwd creates a fresh approval.

Codex MCP tool approval elicitations route through OpenClaw's plugin approval
flow when Codex marks `_meta.codex_approval_kind` as `"mcp_tool_call"`.
Plugin, account, Computer Use, and MCP approval classification runs before
ordinary input handling. A denied policy or unmappable approval schema returns
an explicit decline and never becomes a general-purpose form.

OpenClaw supports app-server MCP elicitation modes `form`, `openai/form`, and
`url`. Standard and extended forms can contain at most 12 fields. OpenClaw
normalizes field names to Gateway-safe question IDs, retains the original names
in accepted content, and presents fields in sequential batches of up to three.
Each field may offer at most four choices; fields and choices over those limits
are declined rather than truncated. Supported fields are free-form strings,
string `enum` or `oneOf` choices, booleans, numbers and integers, and
multi-select string arrays. Free-form string values are limited to 4,096
characters. String length, `email`, `uri`, `date`, and
`date-time` constraints and numeric or array bounds are validated before an
accepted response is returned. Optional fields, required fields, and valid
defaults retain their schema meaning.

`openai/form` also supports a single-select `openai/imagePicker` field with up
to four bounded item IDs and titles. OpenClaw uses only those IDs and titles; it
does not fetch or render item images. An unknown extended field type produces a
visible operator message and an explicit decline. This visible fallback is part
of the `openai/form` capability contract.

URL elicitations are shown as literal text with explicit Continue and Decline
choices. OpenClaw does not fetch or open the URL. URLs are limited to 2,048
characters, must use HTTP or HTTPS, cannot include credentials, and cannot
contain control or invisible characters. Invalid URLs produce a visible
explanation and an explicit decline.

Codex `request_user_input` and ordinary MCP elicitations share one per-turn
interactive queue. The Control UI renders each non-secret Gateway question, and
a single choice uses typed channel buttons when the channel supports them.
Button taps, Control UI answers, and the next queued plain-text reply resolve
the same exact app-server request. `serverRequest/resolved` selects a request by
its outer string-or-integer JSON-RPC ID; attempt abort, timeout, and cleanup
cancel the current owner. Late answers cannot resolve a queued replacement.

Only an explicit field `isSecret: true` or Codex question
`isSecret: true` enables secret handling. Secret form fields are requested one
at a time through the warned ephemeral text-reply path and never create durable
Gateway question records. OpenClaw does not infer secrecy from field names.

For the general plugin approval flow that carries these prompts, see
[Plugin permission requests](/plugins/plugin-permission-requests).
