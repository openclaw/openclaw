---
summary: "Sintaks ng directive para sa /think + /verbose at kung paano nila naaapektuhan ang pangangatwiran ng model"
read_when:
  - Ina-adjust ang pag-parse o mga default ng thinking o verbose directive
title: "Mga Antas ng Pag-iisip"
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
  - Z.AI (`zai/*`) only supports binary thinking (`on`/`off`). Any non-`off` level is treated as `on` (mapped to `low`).

## Ayos ng resolusyon

1. Inline directive sa mensahe (naaangkop lang sa mensaheng iyon).
2. Session override (itinatakda sa pamamagitan ng pagpapadala ng directive-only na mensahe).
3. Global default (`agents.defaults.thinkingDefault` sa config).
4. Fallback: low para sa mga model na may kakayahang mangatuwiran; off kung hindi.

## Pagtatakda ng session default

- Send a message that is **only** the directive (whitespace allowed), e.g. `/think:medium` or `/t high`.
- Mananatili ito para sa kasalukuyang session (per-sender bilang default); na-clear ng `/think:off` o ng session idle reset.
- Kung hindi wasto ang antas (hal. `/thinking big`), tinatanggihan ang command na may pahiwatig at nananatiling hindi nababago ang estado ng session. If the level is invalid (e.g. `/thinking big`), the command is rejected with a hint and the session state is left unchanged.
- Ipadala ang `/think` (o `/think:`) nang walang argument para makita ang kasalukuyang antas ng pag-iisip.

## Paglalapat ayon sa agent

- **Embedded Pi**: ang naresolbang antas ay ipinapasa sa in-process Pi agent runtime.

## Mga verbose directive (/verbose o /v)

- Mga antas: `on` (minimal) | `full` | `off` (default).
- Ang directive-only na mensahe ay nagto-toggle ng session verbose at nagrereply ng `Verbose logging enabled.` / `Verbose logging disabled.`; ang mga invalid na antas ay nagbabalik ng hint nang hindi binabago ang estado.
- Ang `/verbose off` ay nag-iimbak ng tahasang session override; i-clear ito sa pamamagitan ng Sessions UI sa pagpili ng `inherit`.
- Ang inline directive ay nakaaapekto lang sa mensaheng iyon; nalalapat ang session/global defaults kung hindi.
- Ipadala ang `/verbose` (o `/verbose:`) nang walang argument para makita ang kasalukuyang verbose level.
- When verbose is on, agents that emit structured tool results (Pi, other JSON agents) send each tool call back as its own metadata-only message, prefixed with `<emoji> <tool-name>: <arg>` when available (path/command). Kapag ang verbose ay `full`, ang mga output ng tool ay ipinapasa rin pagkatapos makumpleto (hiwa-hiwalay na bubble, pinaikli sa ligtas na haba).
- Kung i-toggle mo ang `/verbose on|full|off` habang may tumatakbong run, igagalang ng mga susunod na tool bubble ang bagong setting. Ang body ng heartbeat probe ay ang naka-configure na heartbeat prompt (default: \`Read HEARTBEAT.md if it exists (workspace context).

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

- Sundin ito nang mahigpit. Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.\`). Inline directives in a heartbeat message apply as usual (but avoid changing session defaults from heartbeats).
- Heartbeat delivery defaults to the final payload only. To also send the separate `Reasoning:` message (when available), set `agents.defaults.heartbeat.includeReasoning: true` or per-agent `agents.list[].heartbeat.includeReasoning: true`.

## Web chat UI

- Ang thinking selector ng web chat ay sumasalamin sa nakaimbak na antas ng session mula sa inbound session store/config kapag nag-load ang page.
- Ang pagpili ng ibang antas ay nalalapat lang sa susunod na mensahe (`thinkingOnce`); pagkatapos magpadala, babalik ang selector sa nakaimbak na antas ng session.
- Para baguhin ang session default, magpadala ng `/think:<level>` na directive (gaya ng dati); ipapakita ito ng selector pagkatapos ng susunod na reload.
