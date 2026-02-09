---
summary: "Disenyo ng command queue na nagsi-serialize ng mga inbound auto-reply run"
read_when:
  - Binabago ang pagpapatupad o concurrency ng auto-reply
title: "Command Queue"
---

# Command Queue (2026-01-16)

Nagse-serialize kami ng mga inbound auto-reply run (lahat ng channel) gamit ang isang maliit na in-process queue upang maiwasan ang banggaan ng maraming agent run, habang pinapayagan pa rin ang ligtas na parallelism sa iba’t ibang session.

## Bakit

- Maaaring maging mahal ang mga auto-reply run (mga LLM call) at maaaring magbanggaan kapag maraming inbound message ang dumarating nang halos sabay.
- Ang pagse-serialize ay umiiwas sa sabayang paggamit ng mga shared resource (mga session file, log, CLI stdin) at nagpapababa ng tsansa ng upstream rate limit.

## Paano ito gumagana

- Isang lane-aware FIFO queue ang nagda-drain ng bawat lane na may configurable na concurrency cap (default 1 para sa mga lane na walang config; ang main ay default na 4, at ang subagent ay 8).
- Ang `runEmbeddedPiAgent` ay nag-e-enqueue batay sa **session key** (lane `session:<key>`) upang masiguro na iisa lang ang aktibong run bawat session.
- Ang bawat session run ay saka ini-e-enqueue sa isang **global lane** (`main` bilang default) upang ang kabuuang parallelism ay ma-cap ng `agents.defaults.maxConcurrent`.
- Kapag naka-enable ang verbose logging, ang mga naka-queue na run ay maglalabas ng maikling abiso kung naghintay sila nang mahigit ~2s bago magsimula.
- Ang mga typing indicator ay agad pa ring nagpapakita sa oras ng enqueue (kapag sinusuportahan ng channel) kaya hindi nagbabago ang karanasan ng user habang naghihintay ng turn.

## Mga queue mode (bawat channel)

Maaaring idirekta ng mga inbound message ang kasalukuyang run, maghintay ng followup turn, o gawin ang pareho:

- `steer`: inject immediately into the current run (cancels pending tool calls after the next tool boundary). If not streaming, falls back to followup.
- `followup`: i-enqueue para sa susunod na agent turn matapos matapos ang kasalukuyang run.
- `collect`: coalesce all queued messages into a **single** followup turn (default). If messages target different channels/threads, they drain individually to preserve routing.
- `steer-backlog` (aka `steer+backlog`): mag-steer ngayon **at** panatilihin ang message para sa followup turn.
- `interrupt` (legacy): ihinto ang aktibong run para sa session na iyon, pagkatapos ay patakbuhin ang pinakabagong message.
- `queue` (legacy alias): kapareho ng `steer`.

Steer-backlog means you can get a followup response after the steered run, so
streaming surfaces can look like duplicates. Prefer `collect`/`steer` if you want
one response per inbound message.
Send `/queue collect` as a standalone command (per-session) or set `messages.queue.byChannel.discord: "collect"`.

Mga default (kapag hindi naka-set sa config):

- Lahat ng surface → `collect`

I-configure nang global o bawat channel gamit ang `messages.queue`:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Mga opsyon ng queue

Nalalapat ang mga opsyon sa `followup`, `collect`, at `steer-backlog` (at sa `steer` kapag bumalik ito sa followup):

- `debounceMs`: maghintay ng katahimikan bago magsimula ng followup turn (iniiwasan ang “continue, continue”).
- `cap`: maximum na naka-queue na message bawat session.
- `drop`: overflow policy (`old`, `new`, `summarize`).

Summarize keeps a short bullet list of dropped messages and injects it as a synthetic followup prompt.
Defaults: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Mga override bawat session

- Ipadala ang `/queue <mode>` bilang standalone na command upang i-store ang mode para sa kasalukuyang session.
- Maaaring pagsamahin ang mga opsyon: `/queue collect debounce:2s cap:25 drop:summarize`
- Nililinis ng `/queue default` o `/queue reset` ang session override.

## Saklaw at mga garantiya

- Nalalapat sa mga auto-reply agent run sa lahat ng inbound channel na gumagamit ng gateway reply pipeline (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, atbp.).
- Ang default lane (`main`) ay process-wide para sa inbound + main heartbeat; itakda ang `agents.defaults.maxConcurrent` upang payagan ang maraming session na tumakbo nang parallel.
- Maaaring may mga karagdagang lane (hal. `cron`, `subagent`) upang makatakbo nang parallel ang mga background job nang hindi hinaharangan ang mga inbound reply.
- Ginagarantiyahan ng mga per-session lane na iisa lang ang agent run na humahawak sa isang session sa anumang oras.
- Walang external dependency o background worker thread; purong TypeScript + promises.

## Pag-troubleshoot

- Kung tila na-stuck ang mga command, i-enable ang verbose log at hanapin ang mga linyang “queued for …ms” upang makumpirma na nagda-drain ang queue.
- Kung kailangan mo ang queue depth, i-enable ang verbose log at bantayan ang mga linya ng queue timing.
