# Agents API harness

The `agentsapi` harness uses API-key authentication and an OpenAI-hosted Linux
environment. Select it through `agents.defaults.agentRuntime.id` or an agent's
`agentRuntime.id`. See the [harness configuration reference](https://docs.openclaw.ai/plugins/sdk-agent-harness/runtime-config).

Token accounting reads canonical native turn records after settlement, since
completion stream events can omit usage. Each OpenClaw attempt counts its new
coordinator turns once, including work superseded by steering. Earlier turns in
the same native session are excluded. Cached input is counted separately from
uncached input; reasoning tokens remain included in output tokens.

Successful assistant messages retain those totals in the OpenClaw transcript.
Run results and completion hooks also retain usage reported for interrupted or
failed work after native cleanup settles. Historical session usage is derived
from transcript messages, so interrupted work without an assistant message is
not included in that historical report. Missing native usage remains unavailable.

Native turn billing can sum multiple model calls. It does not establish the
current context-window usage. Cost estimates use the configured model prices;
they are not provider billing receipts.
