---
summary: "Doctor command: mga health check, config migration, at mga hakbang sa pag-aayos"
read_when:
  - Pagdaragdag o pagbabago ng mga doctor migration
  - Pagpapakilala ng mga breaking na pagbabago sa config
title: "Doctor"
x-i18n:
  source_path: gateway/doctor.md
  source_hash: df7b25f60fd08d50
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:58Z
---

# Doctor

`openclaw doctor` ang repair + migration tool para sa OpenClaw. Inaayos nito ang mga lumang config/state, nagsasagawa ng health check, at nagbibigay ng mga konkretong hakbang sa pag-aayos.

## Mabilis na pagsisimula

```bash
openclaw doctor
```

### Headless / automation

```bash
openclaw doctor --yes
```

Tanggapin ang mga default nang walang prompt (kasama ang mga hakbang sa restart/service/sandbox repair kapag naaangkop).

```bash
openclaw doctor --repair
```

Ilapat ang mga inirerekomendang repair nang walang prompt (mga repair + restart kung ligtas).

```bash
openclaw doctor --repair --force
```

Ilapat din ang mga agresibong repair (ino-overwrite ang mga custom supervisor config).

```bash
openclaw doctor --non-interactive
```

Patakbuhin nang walang mga prompt at ilapat lamang ang mga ligtas na migration (config normalization + paglipat ng state sa disk). Nilalaktawan ang mga aksyon sa restart/service/sandbox na nangangailangan ng kumpirmasyon ng tao.
Awtomatikong tumatakbo ang mga legacy state migration kapag na-detect.

```bash
openclaw doctor --deep
```

I-scan ang mga system service para sa mga karagdagang gateway install (launchd/systemd/schtasks).

Kung gusto mong suriin ang mga pagbabago bago magsulat, buksan muna ang config file:

```bash
cat ~/.openclaw/openclaw.json
```

## Ano ang ginagawa nito (buod)

- Opsyonal na pre-flight update para sa mga git install (interactive lang).
- UI protocol freshness check (nirerebuild ang Control UI kapag mas bago ang protocol schema).
- Health check + prompt sa restart.
- Buod ng status ng Skills (eligible/missing/blocked).
- Config normalization para sa mga legacy na value.
- Mga babala sa OpenCode Zen provider override (`models.providers.opencode`).
- Legacy on-disk state migration (sessions/agent dir/WhatsApp auth).
- Mga check sa integridad at permiso ng state (sessions, transcripts, state dir).
- Mga check sa permiso ng config file (chmod 600) kapag lokal na tumatakbo.
- Model auth health: chine-check ang OAuth expiry, puwedeng mag-refresh ng papalapit na mag-expire na token, at nag-uulat ng auth-profile cooldown/disabled na estado.
- Pagtukoy ng mga extra workspace dir (`~/openclaw`).
- Pag-aayos ng sandbox image kapag naka-enable ang sandboxing.
- Legacy service migration at pagtukoy ng mga extra gateway.
- Mga runtime check ng Gateway (service na naka-install pero hindi tumatakbo; cached launchd label).
- Mga babala sa status ng channel (sinusuri mula sa tumatakbong Gateway).
- Supervisor config audit (launchd/systemd/schtasks) na may opsyonal na repair.
- Mga best-practice check sa Gateway runtime (Node vs Bun, mga path ng version manager).
- Diagnostics ng port collision ng Gateway (default `18789`).
- Mga babala sa seguridad para sa bukas na DM policy.
- Mga babala sa Gateway auth kapag walang `gateway.auth.token` na naka-set (local mode; nag-aalok ng token generation).
- systemd linger check sa Linux.
- Mga check sa source install (pnpm workspace mismatch, nawawalang UI asset, nawawalang tsx binary).
- Nagsusulat ng na-update na config + wizard metadata.

## Detalyadong gawi at paliwanag

### 0) Opsyonal na update (git installs)

Kung ito ay isang git checkout at interactive na tumatakbo ang doctor, nag-aalok itong
mag-update (fetch/rebase/build) bago patakbuhin ang doctor.

### 1) Config normalization

Kung ang config ay may mga legacy na hugis ng value (halimbawa `messages.ackReaction`
na walang channel-specific override), nini-normalize ng doctor ang mga ito sa kasalukuyang
schema.

### 2) Legacy config key migrations

Kapag ang config ay may mga deprecated na key, tumatanggi ang ibang command na tumakbo at hinihiling
na patakbuhin mo ang `openclaw doctor`.

Gagawin ng Doctor ang mga sumusunod:

- Ipaliwanag kung aling mga legacy key ang natagpuan.
- Ipakita ang migration na inilapat nito.
- Isulat muli ang `~/.openclaw/openclaw.json` gamit ang na-update na schema.

Awtomatikong pinapatakbo rin ng Gateway ang mga doctor migration sa startup kapag
na-detect nito ang legacy na format ng config, kaya naaayos ang mga lumang config
nang walang manu-manong interbensyon.

Mga kasalukuyang migration:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → top-level `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen provider overrides

Kung manu-mano kang nagdagdag ng `models.providers.opencode` (o `opencode-zen`), ino-override nito
ang built-in OpenCode Zen catalog mula sa `@mariozechner/pi-ai`. Maaari nitong pilitin
ang bawat model na gumamit ng iisang API o gawing zero ang mga gastos. Nagbababala ang Doctor
para maalis mo ang override at maibalik ang per-model API routing + gastos.

### 3) Legacy state migrations (disk layout)

Kayang i-migrate ng Doctor ang mas lumang on-disk layout papunta sa kasalukuyang istruktura:

- Sessions store + transcripts:
  - mula `~/.openclaw/sessions/` patungo `~/.openclaw/agents/<agentId>/sessions/`
- Agent dir:
  - mula `~/.openclaw/agent/` patungo `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp auth state (Baileys):
  - mula sa legacy `~/.openclaw/credentials/*.json` (maliban sa `oauth.json`)
  - patungo `~/.openclaw/credentials/whatsapp/<accountId>/...` (default account id: `default`)

Ang mga migration na ito ay best-effort at idempotent; maglalabas ng mga babala ang doctor kapag
may iniwang legacy folder bilang backup. Ang Gateway/CLI ay awtomatikong nagmi-migrate din
ng legacy sessions + agent dir sa startup para mapunta ang history/auth/models sa per-agent path
nang hindi na kailangan ng manu-manong doctor run. Ang WhatsApp auth ay sadyang
mina-migrate lamang sa pamamagitan ng `openclaw doctor`.

### 4) Mga check sa integridad ng state (session persistence, routing, at kaligtasan)

Ang state directory ang operasyonal na utak. Kapag nawala ito, mawawala ang mga
session, credential, log, at config (maliban kung may backup ka sa ibang lugar).

Sinusuri ng Doctor ang:

- **Nawawalang state dir**: nagbababala tungkol sa malubhang pagkawala ng state, nagpo-prompt na likhain muli
  ang directory, at pinaaalalahanan na hindi nito mare-recover ang nawawalang data.
- **Mga permiso ng state dir**: tinitiyak na writable; nag-aalok na ayusin ang mga permiso
  (at naglalabas ng `chown` na pahiwatig kapag may owner/group mismatch).
- **Nawawalang session dir**: ang `sessions/` at ang session store directory ay
  kinakailangan para mapanatili ang history at maiwasan ang `ENOENT` na crash.
- **Transcript mismatch**: nagbababala kapag ang mga kamakailang entry ng session ay may nawawalang
  transcript file.
- **Main session “1-line JSONL”**: tina-flag kapag ang pangunahing transcript ay may iisang
  linya lamang (hindi naiipon ang history).
- **Maramihang state dir**: nagbababala kapag may maraming `~/.openclaw` folder sa iba’t ibang
  home directory o kapag ang `OPENCLAW_STATE_DIR` ay tumuturo sa ibang lokasyon (puwedeng
  mahati ang history sa iba’t ibang install).
- **Paalala sa remote mode**: kung `gateway.mode=remote`, pinaaalalahanan ka ng doctor na patakbuhin
  ito sa remote host (doon nakatira ang state).
- **Mga permiso ng config file**: nagbababala kung ang `~/.openclaw/openclaw.json` ay
  nababasa ng group/world at nag-aalok na higpitan sa `600`.

### 5) Model auth health (OAuth expiry)

Sinusuri ng Doctor ang mga OAuth profile sa auth store, nagbababala kapag ang mga token ay
papalapit nang mag-expire o expired na, at maaaring i-refresh ang mga ito kapag ligtas.
Kung ang Anthropic Claude Code profile ay luma na, iminumungkahi nitong patakbuhin ang
`claude setup-token` (o mag-paste ng setup-token). Lumalabas lamang ang mga prompt sa refresh
kapag interactive (TTY) ang takbo; nilalaktawan ng `--non-interactive` ang mga pagtatangkang mag-refresh.

Nag-uulat din ang Doctor ng mga auth profile na pansamantalang hindi magagamit dahil sa:

- maiikling cooldown (rate limit/timeout/auth failure)
- mas mahahabang disable (billing/credit failure)

### 6) Hooks model validation

Kung naka-set ang `hooks.gmail.model`, bina-validate ng doctor ang model reference laban sa
catalog at allowlist at nagbababala kapag hindi ito mare-resolve o hindi pinapayagan.

### 7) Pag-aayos ng sandbox image

Kapag naka-enable ang sandboxing, sine-check ng doctor ang mga Docker image at nag-aalok na
mag-build o lumipat sa mga legacy na pangalan kung nawawala ang kasalukuyang image.

### 8) Mga migration ng Gateway service at mga pahiwatig sa cleanup

Tinutukoy ng Doctor ang mga legacy gateway service (launchd/systemd/schtasks) at
nag-aalok na alisin ang mga ito at i-install ang OpenClaw service gamit ang kasalukuyang gateway
port. Maaari rin nitong i-scan ang mga karagdagang gateway-like service at mag-print ng mga
pahiwatig sa cleanup. Ang mga profile-named OpenClaw gateway service ay itinuturing na first-class
at hindi tina-flag bilang “extra.”

### 9) Mga babala sa seguridad

Naglalabas ang Doctor ng mga babala kapag ang isang provider ay bukas sa DM nang walang allowlist,
o kapag ang isang policy ay naka-configure sa mapanganib na paraan.

### 10) systemd linger (Linux)

Kung tumatakbo bilang systemd user service, tinitiyak ng doctor na naka-enable ang lingering
para manatiling buhay ang gateway kahit mag-logout.

### 11) Status ng Skills

Nagpi-print ang Doctor ng mabilis na buod ng eligible/missing/blocked na Skills para sa kasalukuyang
workspace.

### 12) Mga check sa Gateway auth (local token)

Nagbababala ang Doctor kapag nawawala ang `gateway.auth` sa isang lokal na gateway at nag-aalok na
bumuo ng token. Gamitin ang `openclaw doctor --generate-gateway-token` para pilitin ang paglikha ng token
sa automation.

### 13) Health check ng Gateway + restart

Nagpapatakbo ang Doctor ng health check at nag-aalok na i-restart ang gateway kapag
tila hindi malusog.

### 14) Mga babala sa status ng channel

Kung malusog ang gateway, nagpapatakbo ang doctor ng channel status probe at nag-uulat
ng mga babala na may mga iminungkahing ayos.

### 15) Supervisor config audit + repair

Sinusuri ng Doctor ang naka-install na supervisor config (launchd/systemd/schtasks) para sa
mga nawawala o luma nang default (hal., systemd network-online dependency at
restart delay). Kapag may natagpuang mismatch, nagrerekomenda ito ng update at maaaring
isulat muli ang service file/task ayon sa kasalukuyang default.

Mga tala:

- `openclaw doctor` nagpo-prompt bago muling isulat ang supervisor config.
- `openclaw doctor --yes` tinatanggap ang mga default na repair prompt.
- `openclaw doctor --repair` inilalapat ang mga inirerekomendang ayos nang walang prompt.
- `openclaw doctor --repair --force` ino-overwrite ang mga custom supervisor config.
- Maaari mong laging pilitin ang full rewrite gamit ang `openclaw gateway install --force`.

### 16) Gateway runtime + port diagnostics

Sinusuri ng Doctor ang runtime ng service (PID, huling exit status) at nagbababala kapag ang
service ay naka-install ngunit hindi talaga tumatakbo. Sine-check din nito ang mga port collision
sa gateway port (default `18789`) at nag-uulat ng mga posibleng sanhi (may tumatakbong
gateway na, SSH tunnel).

### 17) Mga best practice sa Gateway runtime

Nagbababala ang Doctor kapag ang Gateway service ay tumatakbo sa Bun o sa path ng Node na pinamamahalaan
ng version manager (`nvm`, `fnm`, `volta`, `asdf`, atbp.). Ang mga channel ng WhatsApp + Telegram ay nangangailangan ng Node,
at ang mga path ng version manager ay maaaring masira pagkatapos ng upgrade dahil hindi
nilo-load ng service ang iyong shell init. Nag-aalok ang Doctor na mag-migrate sa system Node
install kapag available (Homebrew/apt/choco).

### 18) Pagsusulat ng config + wizard metadata

Ipinapersist ng Doctor ang anumang pagbabago sa config at tinatatakan ng wizard metadata
para itala ang doctor run.

### 19) Mga tip sa workspace (backup + memory system)

Iminumungkahi ng Doctor ang isang workspace memory system kapag wala at nagpi-print ng tip sa backup
kung ang workspace ay wala pa sa git.

Tingnan ang [/concepts/agent-workspace](/concepts/agent-workspace) para sa kumpletong gabay sa
istruktura ng workspace at git backup (inirerekomenda ang pribadong GitHub o GitLab).
