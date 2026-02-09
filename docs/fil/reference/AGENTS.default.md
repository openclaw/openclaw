---
summary: "Mga default na tagubilin ng OpenClaw agent at talaan ng Skills para sa setup ng personal assistant"
read_when:
  - Pagsisimula ng bagong OpenClaw agent session
  - Pag-enable o pag-audit ng mga default na Skills
---

# AGENTS.md — OpenClaw Personal Assistant (default)

## Unang run (inirerekomenda)

OpenClaw uses a dedicated workspace directory for the agent. Default: `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`).

1. Gumawa ng workspace (kung wala pa):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Kopyahin ang mga default workspace template papunta sa workspace:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Opsyonal: kung gusto mo ang personal assistant na talaan ng Skills, palitan ang AGENTS.md ng file na ito:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Opsyonal: pumili ng ibang workspace sa pamamagitan ng pag-set ng `agents.defaults.workspace` (sumusuporta sa `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Mga default sa kaligtasan

- Huwag mag-dump ng mga directory o lihim sa chat.
- Huwag magpatakbo ng mga mapanirang command maliban kung hayagang hinihingi.
- Huwag magpadala ng bahagya/streaming na mga sagot sa mga external na messaging surface (mga final na sagot lang).

## Pagsisimula ng session (kinakailangan)

- Basahin ang `SOUL.md`, `USER.md`, `memory.md`, at ngayon+kahapon sa `memory/`.
- Gawin ito bago sumagot.

## Kaluluwa (kinakailangan)

- `SOUL.md` defines identity, tone, and boundaries. Keep it current.
- Kung babaguhin mo ang `SOUL.md`, ipaalam sa user.
- Bawat session ay isang sariwang instance; ang continuity ay nasa mga file na ito.

## Mga shared space (inirerekomenda)

- Hindi ikaw ang boses ng user; mag-ingat sa mga group chat o pampublikong channel.
- Huwag magbahagi ng pribadong data, contact info, o internal na tala.

## Sistema ng memorya (inirerekomenda)

- Daily log: `memory/YYYY-MM-DD.md` (gumawa ng `memory/` kung kailangan).
- Pangmatagalang memorya: `memory.md` para sa mga pangmatagalang fact, preference, at desisyon.
- Sa pagsisimula ng session, basahin ang ngayon + kahapon + `memory.md` kung mayroon.
- I-capture: mga desisyon, preference, constraint, mga bukas na loop.
- Iwasan ang mga lihim maliban kung hayagang hinihiling.

## Mga tool at Skills

- Ang mga tool ay nasa loob ng Skills; sundin ang `SKILL.md` ng bawat Skill kapag kailangan mo ito.
- Panatilihin ang mga tala na partikular sa environment sa `TOOLS.md` (Mga tala para sa Skills).

## Tip sa backup (inirerekomenda)

Kung itinuturing mo ang workspace na ito bilang “memorya” ni Clawd, gawin itong isang git repo (mas mainam kung private) para ma-back up ang `AGENTS.md` at ang iyong mga memory file.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## Ano ang Ginagawa ng OpenClaw

- Nagpapatakbo ng WhatsApp gateway + Pi coding agent para makabasa/makasulat ang assistant ng mga chat, makakuha ng context, at magpatakbo ng Skills sa pamamagitan ng host Mac.
- Pinamamahalaan ng macOS app ang mga permiso (screen recording, notifications, mikropono) at inilalantad ang `openclaw` CLI sa pamamagitan ng bundled binary nito.
- Ang mga direct chat ay awtomatikong nagsasama sa `main` session ng agent; ang mga group ay nananatiling hiwalay bilang `agent:<agentId>:<channel>:group:<id>` (mga room/channel: `agent:<agentId>:<channel>:channel:<id>`); pinananatiling buhay ng mga heartbeat ang mga background task.

## Mga Pangunahing Skills (i-enable sa Settings → Skills)

- **mcporter** — Tool server runtime/CLI para sa pamamahala ng mga external na skill backend.
- **Peekaboo** — Mabilis na macOS screenshot na may opsyonal na AI vision analysis.
- **camsnap** — Kumuha ng mga frame, clip, o motion alert mula sa RTSP/ONVIF security cam.
- **oracle** — OpenAI-ready agent CLI na may session replay at browser control.
- **eightctl** — Kontrolin ang iyong tulog, mula sa terminal.
- **imsg** — Magpadala, magbasa, at mag-stream ng iMessage at SMS.
- **wacli** — WhatsApp CLI: sync, search, send.
- **discord** — Discord actions: react, stickers, polls. Use `user:<id>` or `channel:<id>` targets (bare numeric ids are ambiguous).
- **gog** — Google Suite CLI: Gmail, Calendar, Drive, Contacts.
- **spotify-player** — Terminal Spotify client para maghanap/mag-queue/kontrolin ang playback.
- **sag** — ElevenLabs speech na may mac-style say UX; default na nag-i-stream sa mga speaker.
- **Sonos CLI** — Kontrolin ang mga Sonos speaker (discover/status/playback/volume/grouping) mula sa mga script.
- **blucli** — Patugtugin, i-group, at i-automate ang mga BluOS player mula sa mga script.
- **OpenHue CLI** — Kontrol sa Philips Hue lighting para sa mga scene at automation.
- **OpenAI Whisper** — Lokal na speech-to-text para sa mabilis na dictation at mga transcript ng voicemail.
- **Gemini CLI** — Mga model ng Google Gemini mula sa terminal para sa mabilis na Q&A.
- **agent-tools** — Utility toolkit para sa mga automation at helper script.

## Mga Tala sa Paggamit

- Mas piliin ang `openclaw` CLI para sa scripting; ang mac app ang humahawak ng mga permiso.
- Patakbuhin ang mga install mula sa tab na Skills; itinatago nito ang button kung mayroon nang binary.
- Panatilihing naka-enable ang mga heartbeat para makapag-iskedyul ang assistant ng mga paalala, mag-monitor ng mga inbox, at mag-trigger ng mga camera capture.
- Canvas UI runs full-screen with native overlays. Avoid placing critical controls in the top-left/top-right/bottom edges; add explicit gutters in the layout and don’t rely on safe-area insets.
- Para sa browser-driven na verification, gamitin ang `openclaw browser` (tabs/status/screenshot) gamit ang OpenClaw-managed Chrome profile.
- Para sa DOM inspection, gamitin ang `openclaw browser eval|query|dom|snapshot` (at `--json`/`--out` kapag kailangan mo ng machine output).
- Para sa mga interaction, gamitin ang `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (ang click/type ay nangangailangan ng snapshot refs; gamitin ang `evaluate` para sa mga CSS selector).
