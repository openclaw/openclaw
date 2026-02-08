---
summary: "Sintaks ng directive para sa /think + /verbose at kung paano nila naaapektuhan ang pangangatwiran ng model"
read_when:
  - Ina-adjust ang pag-parse o mga default ng thinking o verbose directive
title: "Mga Antas ng Pag-iisip"
x-i18n:
  source_path: tools/thinking.md
  source_hash: 0ae614147675be32
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:04Z
---

# Mga Antas ng Pag-iisip (/think directives)

## Ano ang ginagawa nito

- Inline directive sa anumang inbound body: `/t <level>`, `/think:<level>`, o `/thinking <level>`.
- Mga antas (aliases): `off | minimal | low | medium | high | xhigh` (GPT-5.2 + Codex models lang)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (max budget)
  - xhigh → “ultrathink+” (GPT-5.2 + Codex models lang)
  - Ang `x-high`, `x_high`, `extra-high`, `extra high`, at `extra_high` ay naka-map sa `xhigh`.
  - Ang `highest`, `max` ay naka-map sa `high`.
- Mga tala ng provider:
  - Z.AI (`zai/*`) ay sumusuporta lang sa binary thinking (`on`/`off`). Anumang non-`off` na antas ay itinuturing na `on` (naka-map sa `low`).

## Ayos ng resolusyon

1. Inline directive sa mensahe (naaangkop lang sa mensaheng iyon).
2. Session override (itinatakda sa pamamagitan ng pagpapadala ng directive-only na mensahe).
3. Global default (`agents.defaults.thinkingDefault` sa config).
4. Fallback: low para sa mga model na may kakayahang mangatuwiran; off kung hindi.

## Pagtatakda ng session default

- Magpadala ng mensaheng **directive lang** (puwedeng may whitespace), hal. `/think:medium` o `/t high`.
- Mananatili ito para sa kasalukuyang session (per-sender bilang default); na-clear ng `/think:off` o ng session idle reset.
- May ipapadalang kumpirmasyon na reply (`Thinking level set to high.` / `Thinking disabled.`). Kung invalid ang antas (hal. `/thinking big`), tatanggihan ang command na may hint at mananatiling hindi nagbabago ang estado ng session.
- Ipadala ang `/think` (o `/think:`) nang walang argument para makita ang kasalukuyang antas ng pag-iisip.

## Paglalapat ayon sa agent

- **Embedded Pi**: ang naresolbang antas ay ipinapasa sa in-process Pi agent runtime.

## Mga verbose directive (/verbose o /v)

- Mga antas: `on` (minimal) | `full` | `off` (default).
- Ang directive-only na mensahe ay nagto-toggle ng session verbose at nagrereply ng `Verbose logging enabled.` / `Verbose logging disabled.`; ang mga invalid na antas ay nagbabalik ng hint nang hindi binabago ang estado.
- Ang `/verbose off` ay nag-iimbak ng tahasang session override; i-clear ito sa pamamagitan ng Sessions UI sa pagpili ng `inherit`.
- Ang inline directive ay nakaaapekto lang sa mensaheng iyon; nalalapat ang session/global defaults kung hindi.
- Ipadala ang `/verbose` (o `/verbose:`) nang walang argument para makita ang kasalukuyang verbose level.
- Kapag naka-on ang verbose, ang mga agent na naglalabas ng structured tool results (Pi, iba pang JSON agents) ay nagpapadala ng bawat tool call pabalik bilang sarili nitong metadata-only na mensahe, na may prefix na `<emoji> <tool-name>: <arg>` kapag available (path/command). Ipinapadala ang mga buod ng tool na ito sa sandaling magsimula ang bawat tool (hiwalay na bubbles), hindi bilang streaming deltas.
- Kapag ang verbose ay `full`, ipinapasa rin ang mga output ng tool pagkatapos ng completion (hiwalay na bubble, pinaikli sa ligtas na haba). Kung i-toggle mo ang `/verbose on|full|off` habang may tumatakbong run, igagalang ng mga susunod na tool bubble ang bagong setting.

## Visibility ng pangangatwiran (/reasoning)

- Mga antas: `on|off|stream`.
- Ang directive-only na mensahe ay nagto-toggle kung ipinapakita ang mga thinking block sa mga reply.
- Kapag naka-enable, ipinapadala ang reasoning bilang **hiwalay na mensahe** na may prefix na `Reasoning:`.
- `stream` (Telegram lang): ini-stream ang reasoning sa Telegram draft bubble habang ginagawa ang reply, pagkatapos ay ipinapadala ang final na sagot nang walang reasoning.
- Alias: `/reason`.
- Ipadala ang `/reasoning` (o `/reasoning:`) nang walang argument para makita ang kasalukuyang reasoning level.

## Kaugnay

- Ang mga docs ng Elevated mode ay nasa [Elevated mode](/tools/elevated).

## Mga Heartbeat

- Ang heartbeat probe body ay ang naka-configure na heartbeat prompt (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Nalalapat ang mga inline directive sa isang heartbeat message gaya ng karaniwan (ngunit iwasang baguhin ang session defaults mula sa mga heartbeat).
- Ang delivery ng heartbeat ay default sa final payload lang. Para ipadala rin ang hiwalay na mensaheng `Reasoning:` (kapag available), itakda ang `agents.defaults.heartbeat.includeReasoning: true` o per-agent na `agents.list[].heartbeat.includeReasoning: true`.

## Web chat UI

- Ang thinking selector ng web chat ay sumasalamin sa nakaimbak na antas ng session mula sa inbound session store/config kapag nag-load ang page.
- Ang pagpili ng ibang antas ay nalalapat lang sa susunod na mensahe (`thinkingOnce`); pagkatapos magpadala, babalik ang selector sa nakaimbak na antas ng session.
- Para baguhin ang session default, magpadala ng `/think:<level>` na directive (gaya ng dati); ipapakita ito ng selector pagkatapos ng susunod na reload.
