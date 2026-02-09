---
summary: "Lifecycle ng agent loop, mga stream, at semantika ng paghihintay"
read_when:
  - Kailangan mo ng eksaktong walkthrough ng agent loop o mga kaganapan sa lifecycle
title: "Loop ng Agent"
---

# Loop ng Agent (OpenClaw)

Ang agentic loop ang buong “tunay” na run ng isang agent: intake → context assembly → model inference →
tool execution → streaming replies → persistence. Ito ang awtoritatibong landas na ginagawang mga aksyon at isang huling tugon ang isang mensahe,
habang pinananatiling konsistent ang session state.

Sa OpenClaw, ang isang loop ay isang solong, serialized na run kada session na naglalabas ng lifecycle at stream events
habang nag-iisip ang modelo, tumatawag ng mga tool, at nag-i-stream ng output. Ipinapaliwanag ng dokumentong ito kung paano ang autentikong loop na iyon ay
nakakabit end-to-end.

## Mga entry point

- Gateway RPC: `agent` at `agent.wait`.
- CLI: `agent` command.

## Paano ito gumagana (high-level)

1. Biniberipika ng `agent` RPC ang mga param, nireresolba ang session (sessionKey/sessionId), ipinapersist ang session metadata, at agad na ibinabalik ang `{ runId, acceptedAt }`.
2. Pinapatakbo ng `agentCommand` ang agent:
   - nireresolba ang model + mga default ng thinking/verbose
   - nilo-load ang snapshot ng skills
   - tinatawag ang `runEmbeddedPiAgent` (pi-agent-core runtime)
   - nag-e-emit ng **lifecycle end/error** kung ang embedded loop ay hindi nag-emit ng isa
3. `runEmbeddedPiAgent`:
   - sini-serialize ang mga run sa pamamagitan ng per-session + global queues
   - nireresolba ang model + auth profile at binubuo ang pi session
   - nagsu-subscribe sa mga pi event at nag-i-stream ng assistant/tool deltas
   - ipinapatupad ang timeout -> ina-abort ang run kapag lumampas
   - ibinabalik ang mga payload + usage metadata
4. Tinutulay ng `subscribeEmbeddedPiSession` ang mga pi-agent-core event papunta sa OpenClaw `agent` stream:
   - mga tool event => `stream: "tool"`
   - assistant deltas => `stream: "assistant"`
   - mga lifecycle event => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. Ginagamit ng `agent.wait` ang `waitForAgentJob`:
   - naghihintay ng **lifecycle end/error** para sa `runId`
   - nagbabalik ng `{ status: ok|error|timeout, startedAt, endedAt, error?` }\`

## Queueing + concurrency

- Ang mga run ay sine-serialize bawat session key (session lane) at opsyonal sa pamamagitan ng isang global lane.
- Pinipigilan nito ang mga race sa tool/session at pinananatiling consistent ang history ng session.
- Maaaring pumili ang mga messaging channel ng mga queue mode (collect/steer/followup) na nagpapakain sa lane system na ito.
  Tingnan ang [Command Queue](/concepts/queue).

## Paghahanda ng session + workspace

- Nireresolba at nililikha ang workspace; ang mga sandboxed run ay maaaring mag-redirect sa isang sandbox workspace root.
- Nilo-load ang Skills (o muling ginagamit mula sa isang snapshot) at ini-inject sa env at prompt.
- Nireresolba at ini-inject ang mga bootstrap/context file sa system prompt report.
- Kumukuha ng session write lock; binubuksan at inihahanda ang `SessionManager` bago ang streaming.

## Pagbuo ng prompt + system prompt

- Binubuo ang system prompt mula sa base prompt ng OpenClaw, skills prompt, bootstrap context, at mga override kada run.
- Ipinapatupad ang mga model-specific limit at compaction reserve tokens.
- Tingnan ang [System prompt](/concepts/system-prompt) para sa nakikita ng model.

## Mga hook point (kung saan ka puwedeng mag-intercept)

May dalawang hook system ang OpenClaw:

- **Internal hooks** (Gateway hooks): mga event-driven script para sa mga command at lifecycle event.
- **Plugin hooks**: mga extension point sa loob ng agent/tool lifecycle at gateway pipeline.

### Internal hooks (Gateway hooks)

- **`agent:bootstrap`**: tumatakbo habang binubuo ang mga bootstrap file bago ma-finalize ang system prompt.
  Gamitin ito para magdagdag/mag-alis ng mga bootstrap context file.
- **Command hooks**: `/new`, `/reset`, `/stop`, at iba pang command event (tingnan ang Hooks doc).

Tingnan ang [Hooks](/automation/hooks) para sa setup at mga halimbawa.

### Plugin hooks (agent + gateway lifecycle)

Tumatakbo ang mga ito sa loob ng agent loop o gateway pipeline:

- **`before_agent_start`**: mag-inject ng context o mag-override ng system prompt bago magsimula ang run.
- **`agent_end`**: siyasatin ang final na listahan ng mensahe at run metadata pagkatapos makumpleto.
- **`before_compaction` / `after_compaction`**: obserbahan o lagyan ng annotation ang mga compaction cycle.
- **`before_tool_call` / `after_tool_call`**: i-intercept ang mga tool param/result.
- **`tool_result_persist`**: sabayang i-transform ang mga tool result bago maisulat sa session transcript.
- **`message_received` / `message_sending` / `message_sent`**: mga inbound + outbound message hook.
- **`session_start` / `session_end`**: mga hangganan ng session lifecycle.
- **`gateway_start` / `gateway_stop`**: mga kaganapan sa gateway lifecycle.

Tingnan ang [Plugins](/tools/plugin#plugin-hooks) para sa hook API at mga detalye ng pagrehistro.

## Streaming + mga bahagyang sagot

- Ang assistant deltas ay ini-stream mula sa pi-agent-core at inilalabas bilang mga kaganapang `assistant`.
- Ang block streaming ay maaaring maglabas ng mga bahagyang sagot alinman sa `text_end` o `message_end`.
- Ang reasoning streaming ay maaaring ilabas bilang hiwalay na stream o bilang mga block reply.
- Tingnan ang [Streaming](/concepts/streaming) para sa chunking at pag-uugali ng block reply.

## Pagpapatakbo ng tool + mga messaging tool

- Ang mga tool start/update/end event ay inilalabas sa `tool` stream.
- Ang mga tool result ay sini-sanitize para sa laki at mga image payload bago i-log/i-emit.
- Sinusubaybayan ang mga messaging tool send upang pigilan ang duplicate na kumpirmasyon ng assistant.

## Pag-hugis ng sagot + suppression

- Ang mga final payload ay binubuo mula sa:
  - assistant text (at opsyonal na reasoning)
  - inline na buod ng tool (kapag verbose + pinapayagan)
  - assistant error text kapag nag-error ang model
- Ang `NO_REPLY` ay tinatrato bilang silent token at sinasala mula sa mga palabas na payload.
- Inaalis ang mga duplicate ng messaging tool mula sa final na listahan ng payload.
- Kung walang natitirang renderable payload at nag-error ang isang tool, naglalabas ng fallback na tool error reply
  (maliban kung ang isang messaging tool ay nakapagpadala na ng user-visible na sagot).

## Compaction + retries

- Ang auto-compaction ay nag-e-emit ng mga `compaction` stream event at maaaring mag-trigger ng retry.
- Sa retry, nire-reset ang mga in-memory buffer at buod ng tool upang maiwasan ang duplicate na output.
- Tingnan ang [Compaction](/concepts/compaction) para sa compaction pipeline.

## Mga event stream (sa kasalukuyan)

- `lifecycle`: inilalabas ng `subscribeEmbeddedPiSession` (at bilang fallback ng `agentCommand`)
- `assistant`: mga streamed delta mula sa pi-agent-core
- `tool`: mga streamed tool event mula sa pi-agent-core

## Pag-handle ng chat channel

- Ang mga assistant delta ay bina-buffer papunta sa chat `delta` na mga mensahe.
- Isang chat `final` ang inilalabas sa **lifecycle end/error**.

## Mga timeout

- Default ng `agent.wait`: 30s (ang paghihintay lang). Ina-override ng `timeoutMs` na parameter.
- Agent runtime: default ng `agents.defaults.timeoutSeconds` na 600s; ipinapatupad sa `runEmbeddedPiAgent` abort timer.

## Mga lugar kung saan puwedeng matapos nang maaga

- Agent timeout (abort)
- AbortSignal (cancel)
- Gateway disconnect o RPC timeout
- `agent.wait` timeout (wait-only, hindi pinipigilan ang agent)
