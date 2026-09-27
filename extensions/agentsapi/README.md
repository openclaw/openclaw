# Agents API harness

The `agentsapi` harness uses API-key authentication and an OpenAI-hosted Linux
environment. Select it through `agents.defaults.agentRuntime.id` or an agent's
`agentRuntime.id`. See the [harness configuration reference](https://docs.openclaw.ai/plugins/sdk-agent-harness/runtime-config).

Multi-user Gateways are not supported by the Agents API MVP.

Ordinary conversation attempts run OpenClaw's shared `before_prompt_build` hook,
including tool-authorized recall and heartbeat prompt contributions. Per-turn
`prependContext` and `appendContext` are applied on both new and resumed sessions.
System-prompt additions and overrides are captured only when the native session
is created. Updating system instructions on an existing native session is an MVP
implementation gap; reset the OpenClaw session to adopt those changes. The harness
does not move system instructions into user messages. Restrictive hook `toolsAllow`
results are rejected before native dispatch because the harness cannot enforce
turn-scoped restrictions across Gateway and native tools. Steering messages and
isolated completions do not run these conversation prompt hooks.

Memory Core dreaming can generate its diary narrative in a fresh Agents API
session without an executor, supplied functions, native web search, vaults, or
subagents. These calls use the prepared model and API key, do not reuse the
conversation or workspace, and delete the temporary session after settlement.
Cancellation waits for native work to settle before deletion.

Conversation-only API sessions require initial input during creation. If the
service accepts creation but its response is lost, the Gateway may not receive
the session ID needed to cancel or delete that work. Cleanup of known sessions
does not guarantee cleanup in that case.

Restricted sessions still have a tool-surface gap: the service may expose its
own built-in helpers even with no supplied functions or executor. Removing those
helpers is blocked by the Agents API, so a literal zero-tool surface is not
guaranteed. Tool-bearing output is rejected and no required function is executed.
Token and temperature limits are not forwarded because the Agents API session
contract does not expose those settings.

The Gateway must be the only writer to each hosted session bound to OpenClaw.
Send messages, steering, and interrupts through OpenClaw. Do not also write to
that hosted session from another API client or a Gateway with independent state.
Keep write credentials under the trusted Gateway operator's control. This
exclusivity is a deployment requirement, not API-enforced session isolation.
Binding leases coordinate OpenClaw attempts; tool execution retains current
ownership and cancellation checks. External concurrent writers are unsupported.

Message and steering submissions, tool results, and cancellation events retry
HTTP 5xx responses up to twice with bounded backoff. Each submission keeps the
same payload and idempotency key across retries; a new submission gets a new key.
Retries respect the operation's abort signal, session ownership, and an explicit
server instruction not to retry. Other HTTP errors, including conflicts, are
returned to the existing turn recovery logic. This does not repair a session
whose backend startup remains unresolved.

Saved sessions keep their hosted conversation, workspace, and original tool
declarations when Gateway tools are added. Fresh sessions receive the current
Gateway tool declarations. Reset an existing session to adopt the new tool
surface; changing its model or API key still requires a reset.

Child sessions use the same Gateway tool-policy filtering as other OpenClaw
runtimes, including inherited restrictions and the child's role. Denied session
and control tools stay unavailable. Policies that restrict hosted shell, file,
or native web-search access are rejected before the hosted session starts or
resumes; the MVP cannot narrow those native capabilities.

Token accounting reads canonical native turn records after settlement, since
completion stream events can omit usage. Each OpenClaw attempt counts its new
coordinator turns once, including work superseded by steering. Earlier turns in
the same native session are excluded. Cached input is counted separately from
uncached input; reasoning tokens remain included in output tokens.

Successful assistant messages retain those totals in the OpenClaw transcript.
When a Gateway tool ends the native turn, a transcript entry with no assistant
content retains usage without publishing another reply.
Run results and completion hooks also retain usage reported for interrupted or
failed work after native cleanup settles. Historical session usage is derived
from transcript messages, so other interrupted work without an assistant message
is not included in that historical report. A bounded five-second settlement window
waits for late turn records and usage. Counts are not refreshed after that
snapshot. Accounting read failures retain the last available snapshot and log a
warning; they do not discard a completed reply or replace cancellation. Missing
native usage remains unavailable; native counts can change as
upstream accounting arrives. See the
[official usage guide](https://developers.openai.com/api/docs/guides/agents-api/observability).

Native turn billing can sum multiple model calls. It does not establish the
current context-window usage. Cost estimates use the configured model prices;
they are not provider billing receipts.
