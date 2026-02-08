---
summary: "Elevated exec mode at mga direktibang /elevated"
read_when:
  - Ina-adjust ang mga default ng elevated mode, mga allowlist, o pag-uugali ng slash command
title: "Elevated Mode"
x-i18n:
  source_path: tools/elevated.md
  source_hash: 83767a0160930402
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:00Z
---

# Elevated Mode (/elevated directives)

## Ano ang ginagawa nito

- `/elevated on` ay tumatakbo sa host ng Gateway at pinananatili ang mga approval ng exec (kapareho ng `/elevated ask`).
- `/elevated full` ay tumatakbo sa host ng Gateway **at** awtomatikong ina-approve ang exec (nilalaktawan ang mga approval ng exec).
- `/elevated ask` ay tumatakbo sa host ng Gateway ngunit pinananatili ang mga approval ng exec (kapareho ng `/elevated on`).
- `on`/`ask` ay **hindi** pinipilit ang `exec.security=full`; umiiral pa rin ang naka-configure na security/ask policy.
- Binabago lamang ang pag-uugali kapag ang agent ay **sandboxed** (kung hindi, ang exec ay tumatakbo na sa host).
- Mga anyo ng direktiba: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Tanging `on|off|ask|full` lamang ang tinatanggap; anumang iba pa ay magbabalik ng hint at hindi magbabago ng estado.

## Ano ang kinokontrol nito (at ano ang hindi)

- **Availability gates**: `tools.elevated` ang global na baseline. Maaaring higit pang higpitan ng `agents.list[].tools.elevated` ang elevated kada agent (parehong dapat pumayag).
- **Per-session state**: Itinatakda ng `/elevated on|off|ask|full` ang antas ng elevated para sa kasalukuyang session key.
- **Inline directive**: Ang `/elevated on|ask|full` sa loob ng isang mensahe ay nalalapat lamang sa mensaheng iyon.
- **Mga grupo**: Sa mga group chat, ang mga elevated directive ay iginagalang lamang kapag nabanggit ang agent. Ang mga command-only na mensahe na lumalampas sa mga kinakailangan sa pagbanggit ay itinuturing na nabanggit.
- **Host execution**: Pinipilit ng elevated ang `exec` papunta sa host ng Gateway; itinatakda rin ng `full` ang `security=full`.
- **Mga approval**: Nilalaktawan ng `full` ang mga approval ng exec; iginagalang ng `on`/`ask` ang mga ito kapag hinihingi ng mga patakaran ng allowlist/ask.
- **Mga unsandboxed na agent**: no-op para sa lokasyon; naaapektuhan lamang ang gating, logging, at status.
- **Umiiral pa rin ang tool policy**: kung ang `exec` ay tinanggihan ng tool policy, hindi maaaring gamitin ang elevated.
- **Hiwalay sa `/exec`**: Ina-adjust ng `/exec` ang mga per-session default para sa mga awtorisadong sender at hindi nangangailangan ng elevated.

## Resolution order

1. Inline directive sa mensahe (nalalapat lamang sa mensaheng iyon).
2. Session override (itinakda sa pamamagitan ng pagpapadala ng direktiba-only na mensahe).
3. Global default (`agents.defaults.elevatedDefault` sa config).

## Pagtatakda ng session default

- Magpadala ng mensahe na **direktiba lamang** (pinapayagan ang whitespace), hal. `/elevated full`.
- Ipapadala ang kumpirmasyon na tugon (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Kung naka-disable ang elevated access o wala ang sender sa naaprubahang allowlist, ang direktiba ay sasagot ng actionable na error at hindi babaguhin ang estado ng session.
- Ipadala ang `/elevated` (o `/elevated:`) na walang argumento upang makita ang kasalukuyang antas ng elevated.

## Availability + allowlists

- Feature gate: `tools.elevated.enabled` (maaaring naka-off ang default sa pamamagitan ng config kahit suportado ito ng code).
- Sender allowlist: `tools.elevated.allowFrom` na may per-provider na mga allowlist (hal. `discord`, `whatsapp`).
- Per-agent gate: `agents.list[].tools.elevated.enabled` (opsyonal; maaari lamang pang higpitan).
- Per-agent allowlist: `agents.list[].tools.elevated.allowFrom` (opsyonal; kapag itinakda, dapat tumugma ang sender sa **parehong** global + per-agent allowlists).
- Discord fallback: kung ang `tools.elevated.allowFrom.discord` ay hindi isinaad, gagamitin ang listahang `channels.discord.dm.allowFrom` bilang fallback. Itakda ang `tools.elevated.allowFrom.discord` (kahit `[]`) upang i-override. Ang mga per-agent allowlist ay **hindi** gumagamit ng fallback.
- Lahat ng gate ay dapat pumasa; kung hindi, ituturing na hindi available ang elevated.

## Logging + status

- Ang mga elevated exec call ay nilolog sa antas na info.
- Kasama sa session status ang elevated mode (hal. `elevated=ask`, `elevated=full`).
