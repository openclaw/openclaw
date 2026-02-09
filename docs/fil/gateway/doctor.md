---
summary: "Doctor command: mga health check, config migration, at mga hakbang sa pag-aayos"
read_when:
  - Pagdaragdag o pagbabago ng mga doctor migration
  - Pagpapakilala ng mga breaking na pagbabago sa config
title: "Doctor"
---

# Doctor

`openclaw doctor` is the repair + migration tool for OpenClaw. It fixes stale
config/state, checks health, and provides actionable repair steps.

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

Patakbuhin nang walang mga prompt at ilapat lamang ang mga ligtas na migration (config normalization + paglipat ng on-disk state). Skips restart/service/sandbox actions that require human confirmation.
Legacy state migrations run automatically when detected.

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

### 0. Opsyonal na update (git installs)

Kung ito ay isang git checkout at interactive na tumatakbo ang doctor, nag-aalok itong
mag-update (fetch/rebase/build) bago patakbuhin ang doctor.

### 1. Config normalization

Kung ang config ay may mga legacy na hugis ng value (halimbawa `messages.ackReaction`
na walang channel-specific override), nini-normalize ng doctor ang mga ito sa kasalukuyang
schema.

### 2. Legacy config key migrations

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

If you’ve added `models.providers.opencode` (or `opencode-zen`) manually, it
overrides the built-in OpenCode Zen catalog from `@mariozechner/pi-ai`. That can
force every model onto a single API or zero out costs. Doctor warns so you can
remove the override and restore per-model API routing + costs.

### 3. Legacy state migrations (disk layout)

Kayang i-migrate ng Doctor ang mas lumang on-disk layout papunta sa kasalukuyang istruktura:

- Sessions store + transcripts:
  - mula `~/.openclaw/sessions/` patungo `~/.openclaw/agents/<agentId>/sessions/`
- Agent dir:
  - mula `~/.openclaw/agent/` patungo `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp auth state (Baileys):
  - mula sa legacy `~/.openclaw/credentials/*.json` (maliban sa `oauth.json`)
  - patungo `~/.openclaw/credentials/whatsapp/<accountId>/...` (default account id: `default`)

These migrations are best-effort and idempotent; doctor will emit warnings when
it leaves any legacy folders behind as backups. The Gateway/CLI also auto-migrates
the legacy sessions + agent dir on startup so history/auth/models land in the
per-agent path without a manual doctor run. WhatsApp auth is intentionally only
migrated via `openclaw doctor`.

### 4. Mga check sa integridad ng state (session persistence, routing, at kaligtasan)

The state directory is the operational brainstem. If it vanishes, you lose
sessions, credentials, logs, and config (unless you have backups elsewhere).

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

### 5. Model auth health (OAuth expiry)

Doctor inspects OAuth profiles in the auth store, warns when tokens are
expiring/expired, and can refresh them when safe. Kung lipas na ang Anthropic Claude Code profile, iminumungkahi nitong patakbuhin ang `claude setup-token` (o mag-paste ng setup-token).
Refresh prompts only appear when running interactively (TTY); `--non-interactive`
skips refresh attempts.

Nag-uulat din ang Doctor ng mga auth profile na pansamantalang hindi magagamit dahil sa:

- maiikling cooldown (rate limit/timeout/auth failure)
- mas mahahabang disable (billing/credit failure)

### 6. Hooks model validation

Kung naka-set ang `hooks.gmail.model`, bina-validate ng doctor ang model reference laban sa
catalog at allowlist at nagbababala kapag hindi ito mare-resolve o hindi pinapayagan.

### 7. Pag-aayos ng sandbox image

Kapag naka-enable ang sandboxing, sine-check ng doctor ang mga Docker image at nag-aalok na
mag-build o lumipat sa mga legacy na pangalan kung nawawala ang kasalukuyang image.

### 8. Mga migration ng Gateway service at mga pahiwatig sa cleanup

Doctor detects legacy gateway services (launchd/systemd/schtasks) and
offers to remove them and install the OpenClaw service using the current gateway
port. It can also scan for extra gateway-like services and print cleanup hints.
Profile-named OpenClaw gateway services are considered first-class and are not
flagged as "extra."

### 9. Mga babala sa seguridad

Naglalabas ang Doctor ng mga babala kapag ang isang provider ay bukas sa DM nang walang allowlist,
o kapag ang isang policy ay naka-configure sa mapanganib na paraan.

### 10. systemd linger (Linux)

Kung tumatakbo bilang systemd user service, tinitiyak ng doctor na naka-enable ang lingering
para manatiling buhay ang gateway kahit mag-logout.

### 11. Status ng Skills

Nagpi-print ang Doctor ng mabilis na buod ng eligible/missing/blocked na Skills para sa kasalukuyang
workspace.

### 12. Mga check sa Gateway auth (local token)

Doctor warns when `gateway.auth` is missing on a local gateway and offers to
generate a token. Gamitin ang `openclaw doctor --generate-gateway-token` upang pilitin ang paglikha ng token sa automation.

### 13. Health check ng Gateway + restart

Nagpapatakbo ang Doctor ng health check at nag-aalok na i-restart ang gateway kapag
tila hindi malusog.

### 14. Mga babala sa status ng channel

Kung malusog ang gateway, nagpapatakbo ang doctor ng channel status probe at nag-uulat
ng mga babala na may mga iminungkahing ayos.

### 15. Supervisor config audit + repair

Doctor checks the installed supervisor config (launchd/systemd/schtasks) for
missing or outdated defaults (e.g., systemd network-online dependencies and
restart delay). Kapag may nakitang mismatch, nagrerekomenda ito ng update at maaaring muling isulat ang service file/task sa kasalukuyang mga default.

Mga tala:

- `openclaw doctor` nagpo-prompt bago muling isulat ang supervisor config.
- `openclaw doctor --yes` tinatanggap ang mga default na repair prompt.
- `openclaw doctor --repair` inilalapat ang mga inirerekomendang ayos nang walang prompt.
- `openclaw doctor --repair --force` ino-overwrite ang mga custom supervisor config.
- Maaari mong laging pilitin ang full rewrite gamit ang `openclaw gateway install --force`.

### 16. Gateway runtime + port diagnostics

Sinusuri ng Doctor ang service runtime (PID, huling exit status) at nagbababala kapag naka-install ang service ngunit hindi talaga tumatakbo. It also checks for port collisions
on the gateway port (default `18789`) and reports likely causes (gateway already
running, SSH tunnel).

### 17. Mga best practice sa Gateway runtime

Doctor warns when the gateway service runs on Bun or a version-managed Node path
(`nvm`, `fnm`, `volta`, `asdf`, etc.). WhatsApp + Telegram channels require Node,
and version-manager paths can break after upgrades because the service does not
load your shell init. Doctor offers to migrate to a system Node install when
available (Homebrew/apt/choco).

### 18. Pagsusulat ng config + wizard metadata

Ipinapersist ng Doctor ang anumang pagbabago sa config at tinatatakan ng wizard metadata
para itala ang doctor run.

### 19. Mga tip sa workspace (backup + memory system)

Iminumungkahi ng Doctor ang isang workspace memory system kapag wala at nagpi-print ng tip sa backup
kung ang workspace ay wala pa sa git.

Tingnan ang [/concepts/agent-workspace](/concepts/agent-workspace) para sa kumpletong gabay sa
istruktura ng workspace at git backup (inirerekomenda ang pribadong GitHub o GitLab).
