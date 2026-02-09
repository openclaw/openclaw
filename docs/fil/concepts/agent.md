---
summary: "Runtime ng agent (embedded pi-mono), kontrata ng workspace, at bootstrap ng session"
read_when:
  - Pagbabago sa runtime ng agent, bootstrap ng workspace, o pag-uugali ng session
title: "Runtime ng Agent"
---

# Runtime ng Agent 🤖

Ang OpenClaw ay nagpapatakbo ng iisang embedded agent runtime na hango sa **pi-mono**.

## Workspace (kinakailangan)

Gumagamit ang OpenClaw ng iisang agent workspace directory (`agents.defaults.workspace`) bilang **nag-iisa** nitong working directory (`cwd`) para sa mga tool at context.

Inirerekomenda: gamitin ang `openclaw setup` para likhain ang `~/.openclaw/openclaw.json` kung wala pa at i-initialize ang mga file ng workspace.

Buong layout ng workspace + gabay sa backup: [Agent workspace](/concepts/agent-workspace)

Kung naka-enable ang `agents.defaults.sandbox`, puwedeng i-override ito ng mga non-main session gamit ang
per-session na mga workspace sa ilalim ng `agents.defaults.sandbox.workspaceRoot` (tingnan ang
[Gateway configuration](/gateway/configuration)).

## Mga bootstrap file (ini-inject)

Sa loob ng `agents.defaults.workspace`, inaasahan ng OpenClaw ang mga sumusunod na user-editable file:

- `AGENTS.md` — mga tagubiling pang-operasyon + “memory”
- `SOUL.md` — persona, mga hangganan, tono
- `TOOLS.md` — mga tala sa tool na pinapanatili ng user (hal. `imsg`, `sag`, mga convention)
- `BOOTSTRAP.md` — one-time na first-run ritual (binubura matapos makumpleto)
- `IDENTITY.md` — pangalan/vibe/emoji ng agent
- `USER.md` — profile ng user + gustong anyo ng pagtawag

Sa unang turn ng bagong session, ini-inject ng OpenClaw ang laman ng mga file na ito direkta sa agent context.

Tingnan ang
[Channel routing](/channels/channel-routing) para sa routing configuration. Nilalaktawan ang mga blankong file.

Kung may nawawalang file, mag-i-inject ang OpenClaw ng isang linyang marker na “missing file” (at ang `openclaw setup` ay lilikha ng ligtas na default template).

Ang malalaking file ay tine-trim at pinuputol na may marker upang manatiling maigsi ang mga prompt (basahin ang file para sa buong nilalaman). Ang `BOOTSTRAP.md` ay ginagawa lamang para sa isang **bagong-bagong workspace** (walang ibang bootstrap file na naroroon).

Para ganap na i-disable ang paglikha ng mga bootstrap file (para sa mga pre-seeded na workspace), itakda ang:

```json5
{ agent: { skipBootstrap: true } }
```

## Mga built-in na tool

Kung buburahin mo ito matapos makumpleto ang ritwal, hindi na ito dapat muling malikha sa mga susunod na restart. Ang mga core tool (read/exec/edit/write at kaugnay na mga system tool) ay palaging available,
napapailalim sa tool policy. Ang `apply_patch` ay opsyonal at kinokontrol ng
`tools.exec.applyPatch`.

## Skills

Naglo-load ang OpenClaw ng Skills mula sa tatlong lokasyon (nananaig ang workspace kapag may conflict sa pangalan):

- Bundled (kasama sa install)
- Managed/local: `~/.openclaw/skills`
- Workspace: `<workspace>/skills`

Maaaring i-gate ang Skills sa pamamagitan ng config/env (tingnan ang `skills` sa [Gateway configuration](/gateway/configuration)).

## Integrasyon ng pi-mono

Muling ginagamit ng OpenClaw ang ilang bahagi ng pi-mono codebase (models/tools), ngunit **ang pamamahala ng session, discovery, at tool wiring ay pag-aari ng OpenClaw**.

- Walang pi-coding agent runtime.
- Walang mga setting na `~/.pi/agent` o `<workspace>/.pi` na kinokonsulta.

## Mga session

Ang mga transcript ng session ay iniimbak bilang JSONL sa:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

Ang session ID ay stable at pinipili ng OpenClaw.
Ang mga legacy na Pi/Tau session folder ay **hindi** binabasa.

## Steering habang nag-i-stream

Kapag ang queue mode ay `steer`, ang mga inbound na mensahe ay ini-inject sa kasalukuyang run.
Sinusuri ang queue **pagkatapos ng bawat tool call**; kung may naka-queue na mensahe,
ilalaktawan ang natitirang mga tool call mula sa kasalukuyang assistant message (mga error tool
result na may "Skipped due to queued user message."), pagkatapos ay ini-inject ang naka-queue na user
message bago ang susunod na assistant response.

Kapag ang queue mode ay `followup` o `collect`, ang mga inbound na mensahe ay hinahawakan hanggang matapos ang
kasalukuyang turn, pagkatapos ay magsisimula ang isang bagong agent turn gamit ang mga naka-queue na payload. Tingnan ang
[Queue](/concepts/queue) para sa mode + debounce/cap behavior.

Ang block streaming ay nagpapadala ng mga natapos na assistant block sa sandaling matapos ang mga ito; ito ay
**off bilang default** (`agents.defaults.blockStreamingDefault: "off"`).
I-tune ang boundary gamit ang `agents.defaults.blockStreamingBreak` (`text_end` vs `message_end`; default ay text_end).
Kontrolin ang soft block chunking gamit ang `agents.defaults.blockStreamingChunk` (default ay
800–1200 chars; mas pinipili ang paragraph breaks, pagkatapos ang mga newline; huli ang mga pangungusap).
Pagsamahin ang mga streamed chunk gamit ang `agents.defaults.blockStreamingCoalesce` upang mabawasan ang
single-line spam (idle-based na pagsasanib bago ipadala). Ang mga non-Telegram channel ay nangangailangan ng
explicit na `*.blockStreaming: true` upang paganahin ang block replies.
Ang mga verbose na tool summary ay inilalabas sa simula ng tool (walang debounce); ang Control UI ay
nag-i-stream ng tool output sa pamamagitan ng agent events kapag available.
Higit pang detalye: [Streaming + chunking](/concepts/streaming).

## Mga model ref

Ang mga model ref sa config (halimbawa `agents.defaults.model` at `agents.defaults.models`) ay pino-parse sa pamamagitan ng paghahati sa **unang** `/`.

- Gamitin ang `provider/model` kapag kino-configure ang mga model.
- Kung ang mismong model ID ay naglalaman ng `/` (OpenRouter-style), isama ang provider prefix (halimbawa: `openrouter/moonshotai/kimi-k2`).
- Kung aalisin mo ang provider, ituturing ng OpenClaw ang input bilang alias o isang model para sa **default provider** (gagana lamang kapag walang `/` sa model ID).

## Konpigurasyon (minimal)

Sa minimum, itakda ang:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (mahigpit na inirerekomenda)

---

_Susunod: [Group Chats](/channels/group-messages)_ 🦞
