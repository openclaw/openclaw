---
summary: "Paano binubuo ng OpenClaw ang prompt context at nag-uulat ng paggamit ng token + mga gastos"
read_when:
  - Pagpapaliwanag ng paggamit ng token, mga gastos, o mga context window
  - Pag-debug ng paglaki ng context o pag-uugali ng compaction
title: "Paggamit ng Token at Mga Gastos"
x-i18n:
  source_path: reference/token-use.md
  source_hash: f8bfadb36b51830c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:57Z
---

# Paggamit ng token at mga gastos

Sinusubaybayan ng OpenClaw ang **mga token**, hindi mga character. Model-specific ang mga token, pero karamihan sa mga OpenAI-style na model ay nag-a-average ng ~4 na character bawat token para sa English na teksto.

## Paano binubuo ang system prompt

Binubuo ng OpenClaw ang sarili nitong system prompt sa bawat run. Kabilang dito ang:

- Listahan ng mga tool + maiikling paglalarawan
- Listahan ng Skills (metadata lang; ang mga instruction ay nilo-load on demand gamit ang `read`)
- Mga instruction para sa self-update
- Workspace + mga bootstrap file (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` kapag bago). Ang malalaking file ay tina-truncate ng `agents.defaults.bootstrapMaxChars` (default: 20000).
- Oras (UTC + timezone ng user)
- Mga reply tag + heartbeat behavior
- Runtime metadata (host/OS/model/thinking)

Tingnan ang buong breakdown sa [System Prompt](/concepts/system-prompt).

## Ano ang binibilang sa context window

Lahat ng natatanggap ng model ay binibilang sa context limit:

- System prompt (lahat ng seksyong nakalista sa itaas)
- History ng conversation (mga mensahe ng user + assistant)
- Mga tool call at mga resulta ng tool
- Mga attachment/transcript (mga imahe, audio, file)
- Mga compaction summary at pruning artifact
- Mga provider wrapper o safety header (hindi nakikita, pero binibilang pa rin)

Para sa praktikal na breakdown (bawat injected file, mga tool, Skills, at laki ng system prompt), gamitin ang `/context list` o `/context detail`. Tingnan ang [Context](/concepts/context).

## Paano makita ang kasalukuyang paggamit ng token

Gamitin ang mga ito sa chat:

- `/status` → **emoji‑rich na status card** na may session model, paggamit ng context,
  input/output token ng huling response, at **tinatayang gastos** (API key lang).
- `/usage off|tokens|full` → nag-a-append ng **per-response na usage footer** sa bawat reply.
  - Nagpe-persist kada session (naka-store bilang `responseUsage`).
  - Ang OAuth auth ay **nagtatago ng gastos** (token lang).

Iba pang surface:

- **TUI/Web TUI:** sinusuportahan ang `/status` + `/usage`.
- **CLI:** ipinapakita ng `openclaw status --usage` at `openclaw channels list` ang
  mga provider quota window (hindi per-response na gastos).

## Pagtatantiya ng gastos (kapag ipinapakita)

Tinatantiya ang mga gastos mula sa pricing config ng iyong model:

```
models.providers.<provider>.models[].cost
```

Ito ay **USD kada 1M token** para sa `input`, `output`, `cacheRead`, at
`cacheWrite`. Kung kulang ang pricing, token lang ang ipinapakita ng OpenClaw. Ang mga OAuth token ay
hindi kailanman nagpapakita ng dollar na gastos.

## Cache TTL at epekto ng pruning

Ang provider prompt caching ay naaangkop lang sa loob ng cache TTL window. Maaaring
opsyonal na patakbuhin ng OpenClaw ang **cache-ttl pruning**: pinu-prune nito ang session kapag nag-expire na ang cache TTL, pagkatapos ay nire-reset ang cache window para ang mga susunod na request ay muling makagamit ng bagong cache na context sa halip na i-re-cache ang buong history. Pinapababa nito ang cache write costs kapag ang isang session ay naging idle lampas sa TTL.

I-configure ito sa [Gateway configuration](/gateway/configuration) at tingnan ang
mga detalye ng behavior sa [Session pruning](/concepts/session-pruning).

Maaaring panatilihing **warm** ng heartbeat ang cache sa mga idle gap. Kung ang model cache TTL mo ay `1h`, ang pagtatakda ng heartbeat interval na bahagyang mas mababa rito (hal., `55m`) ay maaaring makaiwas sa muling pag-cache ng buong prompt, kaya nababawasan ang cache write costs.

Para sa Anthropic API pricing, mas mura nang malaki ang cache reads kaysa sa input
tokens, habang ang cache writes ay sinisingil sa mas mataas na multiplier. Tingnan ang prompt caching pricing ng Anthropic para sa pinakabagong mga rate at TTL multiplier:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Halimbawa: panatilihing warm ang 1h cache gamit ang heartbeat

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Mga tip para bawasan ang token pressure

- Gamitin ang `/compact` para i-summarize ang mahahabang session.
- I-trim ang malalaking tool output sa iyong mga workflow.
- Panatilihing maikli ang mga skill description (ini-inject ang listahan ng Skills sa prompt).
- Mas piliin ang mas maliliit na model para sa verbose at exploratory na trabaho.

Tingnan ang [Skills](/tools/skills) para sa eksaktong formula ng overhead ng skill list.
