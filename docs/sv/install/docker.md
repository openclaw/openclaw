---
summary: "Valfri Docker-baserad konfiguration och introduktion för OpenClaw"
read_when:
  - Du vill ha en containeriserad gateway i stället för lokala installationer
  - Du validerar Docker-flödet
title: "Docker"
---

# Docker (valfritt)

Docker är **valfritt**. Använd den endast om du vill ha en behållaranpassad inkörsport eller för att validera Docker-flödet.

## Är Docker rätt för mig?

- **Ja**: du vill ha en isolerad, tillfällig gateway-miljö eller köra OpenClaw på en värd utan lokala installationer.
- **Nej**: du kör på din egen maskin och vill bara ha den snabbaste dev-loopen. Använd det normala installationsflödet istället.
- **Sandboxningsanteckning**: agentsandboxning använder också Docker, men det behöver **inte** hela porten för att köras i Docker. Se [Sandboxing](/gateway/sandboxing).

Den här guiden täcker:

- Containeriserad Gateway (hela OpenClaw i Docker)
- Per-session Agent Sandbox (gateway på värden + Docker-isolerade agentverktyg)

Detaljer om sandboxing: [Sandboxing](/gateway/sandboxing)

## Krav

- Docker Desktop (eller Docker Engine) + Docker Compose v2
- Tillräckligt med diskutrymme för images + loggar

## Containeriserad Gateway (Docker Compose)

### Snabbstart (rekommenderas)

Från repo-roten:

```bash
./docker-setup.sh
```

Detta skript:

- bygger gateway-imagen
- kör introduktionsguiden
- skriver ut valfria tips för leverantörskonfiguration
- startar gatewayen via Docker Compose
- genererar en gateway-token och skriver den till `.env`

Valfria miljövariabler:

- `OPENCLAW_DOCKER_APT_PACKAGES` — installera extra apt-paket under bygget
- `OPENCLAW_EXTRA_MOUNTS` — lägg till extra bind-mounts från värden
- `OPENCLAW_HOME_VOLUME` — persist `/home/node` i en namngiven volym

Efter att det är klart:

- Öppna `http://127.0.0.1:18789/` i din webbläsare.
- Klistra in token i Control UI (Inställningar → token).
- Behöver du webbadressen igen? Kör `docker komponera kör --rm openclaw-cli instrumentbräda --no-open`.

Det skriver konfig/arbetsyta på värden:

- `~/.openclaw/`
- `~/.openclaw/workspace`

Kör på en VPS? See [Hetzner (Docker VPS)](/install/hetzner).

### Manuell väg (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Obs: kör `docker komponera ...` från repo roten. Om du aktiverade
`OPENCLAW_EXTRA_MOUNTS` eller `OPENCLAW_HOME_VOLUME`, skriver installationsskriptet
`docker-compose.extra.yml`; inkludera det när du kör Compose någon annanstans:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI-token + parning (Docker)

Om du ser ”unauthorized” eller ”disconnected (1008): pairing required”, hämta en
ny instrumentpanellänk och godkänn webbläsarenheten:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Mer detaljer: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Extra mounts (valfritt)

Om du vill montera ytterligare värdkataloger i behållarna, sätt
`OPENCLAW_EXTRA_MOUNTS` innan du kör `docker-setup.sh`. Detta accepterar en
kommaseparerad lista med Docker bind fästen och tillämpar dem på både
`openclaw-gateway` och `openclaw-cli` genom att generera `docker-compose.extra.yml`.

Exempel:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Noteringar:

- Sökvägar måste delas med Docker Desktop på macOS/Windows.
- Om du redigerar `OPENCLAW_EXTRA_MOUNTS`, kör `docker-setup.sh` igen för att regenerera
  den extra compose-filen.
- `docker-compose.extra.yml` genereras. Redigera den inte.

### Persist hela container-hemmet (valfritt)

Om du vill att `/home/node` ska bestå över behållaren rekreation, ange en namngiven
volym via `OPENCLAW_HOME_VOLUME`. Detta skapar en Docker-volym och monterar den på
`/home/node`, samtidigt som standard config/workspace binder fästen. Använd en
namngiven volym här (inte en bind sökväg); för bind fästen, använd
`OPENCLAW_EXTRA_MOUNTS`.

Exempel:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Du kan kombinera detta med extra mounts:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Noteringar:

- Om du ändrar `OPENCLAW_HOME_VOLUME`, kör `docker-setup.sh` igen för att regenerera
  den extra compose-filen.
- Den namngivna volymen består tills den tas bort med `docker volume rm <name>`.

### Installera extra apt-paket (valfritt)

Om du behöver systempaket inuti bilden (till exempel bygga verktyg eller media
bibliotek), sätt `OPENCLAW_DOCKER_APT_PACKAGES` innan du kör `docker-setup.sh`.
Detta installerar paketen under avbildningsbygget, så de kvarstår även om
behållaren tas bort.

Exempel:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Noteringar:

- Detta accepterar en blankstegsseparerad lista med apt-paketnamn.
- Om du ändrar `OPENCLAW_DOCKER_APT_PACKAGES`, kör `docker-setup.sh` igen för att bygga om
  imagen.

### Avancerat läge / fullfjädrad container (opt-in)

Standardbilden för Docker är **security-first** och körs som icke-root `node`
användare. Detta håller attackytan liten, men det betyder:

- inga systempaketinstallationer vid körning
- ingen Homebrew som standard
- inga medföljande Chromium/Playwright-webbläsare

Om du vill ha en mer fullfjädrad container, använd dessa opt-in-reglage:

1. **Persist `/home/node`** så att webbläsarnedladdningar och verktygscacher överlever:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Baka in systemberoenden i imagen** (repeterbart + bestående):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Installera Playwright-webbläsare utan `npx`** (undviker npm-override-konflikter):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Om du behöver att Playwright installerar systemberoenden, bygg om imagen med
`OPENCLAW_DOCKER_APT_PACKAGES` i stället för att använda `--with-deps` vid körning.

4. **Persist Playwright-webbläsarnedladdningar**:

- Sätt `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` i
  `docker-compose.yml`.
- Säkerställ att `/home/node` består via `OPENCLAW_HOME_VOLUME`, eller montera
  `/home/node/.cache/ms-playwright` via `OPENCLAW_EXTRA_MOUNTS`.

### Behörigheter + EACCES

Bilden körs som `node` (uid 1000). Om du ser behörighetsfel på
`/home/node/.openclaw`, se till att din värd bind fästen ägs av uid 1000.

Exempel (Linux-värd):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Om du väljer att köra som root av bekvämlighetsskäl accepterar du säkerhetsavvägningen.

### Snabbare ombyggnader (rekommenderas)

För att snabba på återuppbyggnaden, beställ din Dockerfile så att beroendelager cachelagras.
Detta undviker att köra om `pnpm install` om inte låsfiler ändras:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### Kanalinställning (valfritt)

Använd CLI-containern för att konfigurera kanaler och starta sedan om gatewayen vid behov.

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (bot-token):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (bot-token):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Dokumentation: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (headless Docker)

Om du väljer OpenAI Codex OAuth i guiden öppnar den en webbläsarURL och försöker
att fånga en callback på `http://127.0.0.1:1455/auth/callback`. I Docker eller
headless setups som callback kan visa ett webbläsarfel. Kopiera hela omdirigera
URL som du landar på och klistra in den i guiden för att avsluta författaren.

### Hälsokontroll

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E-röktest (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR-import-röktest (Docker)

```bash
pnpm test:docker:qr
```

### Noteringar

- Gateway-bindning är som standard `lan` för containeranvändning.
- Dockerfile CMD använder `--allow-unconfigured`; monterad konfiguration med `gateway.mode` inte `local` kommer fortfarande att starta. Åsidosätt CMD för att genomdriva vakten.
- Gateway-containern är sanningskällan för sessioner (`~/.openclaw/agents/<agentId>/sessions/`).

## Agent Sandbox (gateway på värden + Docker-verktyg)

Fördjupning: [Sandboxing](/gateway/sandboxing)

### Vad den gör

När `agents.defaults.sandbox` är aktiverat, **icke-huvudsakliga sessioner** kör verktyg inuti en Docker
behållare. Gateway stannar på din värd, men verktyget utförande är isolerat:

- omfattning: `"agent"` som standard (en container + arbetsyta per agent)
- omfattning: `"session"` för per-session-isolering
- arbetsytemapp per omfattning monterad på `/workspace`
- valfri åtkomst till agentens arbetsyta (`agents.defaults.sandbox.workspaceAccess`)
- policy för tillåt/nekade verktyg (nekad vinner)
- inkommande media kopieras till den aktiva sandbox-arbetsytan (`media/inbound/*`) så att verktyg kan läsa den (med `workspaceAccess: "rw"` hamnar detta i agentens arbetsyta)

Varning: `scope: "shared"` inaktiverar cross-sessions-isolering. Alla sessioner delar
en container och en arbetsyta.

### Sandbox-profiler per agent (multi-agent)

Om du använder multi-agent routing, kan varje agent åsidosätta sandlåda + verktygsinställningar:
`agents.list[].sandbox` och `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools`). Detta låter dig köra
blandade accessnivåer i en gateway:

- Full åtkomst (personlig agent)
- Läsbara verktyg + skrivskyddad arbetsyta (familj-/arbetsagent)
- Inga filsystem-/shell-verktyg (publik agent)

Se [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) för exempel,
prioritet och felsökning.

### Standardbeteende

- Image: `openclaw-sandbox:bookworm-slim`
- En container per agent
- Åtkomst till agentens arbetsyta: `workspaceAccess: "none"` (standard) använder `~/.openclaw/sandboxes`
  - `"ro"` behåller sandbox-arbetsytan på `/workspace` och monterar agentens arbetsyta skrivskyddad på `/agent` (inaktiverar `write`/`edit`/`apply_patch`)
  - `"rw"` monterar agentens arbetsyta läs/skriv på `/workspace`
- Automatisk rensning: inaktiv > 24 h ELLER ålder > 7 d
- Nätverk: `none` som standard (välj explicit om du behöver utgående trafik)
- Standard tillåt: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- Standard neka: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Aktivera sandboxing

Om du planerar att installera paket i `setupCommand`, notera:

- Standard `docker.network` är `"none"` (ingen utgående trafik).
- `readOnlyRoot: true` blockerar paketinstallationer.
- `user` måste vara root för `apt-get` (utelämna `user` eller set `user: "0:0"`).
  OpenClaw återskapar automatiskt behållare när `setupCommand` (eller docker config) ändras
  om inte behållaren **nyligen använts** (inom ~5 minuter). Heta behållare
  logga en varning med det exakta `openclaw sandlådan återskapa ...` kommandot.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Härdningsreglage finns under `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

Multi-agent: åsidosätt `agents.defaults.sandbox.{docker,browser,prune}.*` per agent via `agents.list[].sandbox.{docker,browser,prune}.*`
(ignoreras när `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` är `"shared"`).

### Bygg standard-sandboximagen

```bash
scripts/sandbox-setup.sh
```

Detta bygger `openclaw-sandbox:bookworm-slim` med `Dockerfile.sandbox`.

### Gemensam sandbox-image (valfritt)

Om du vill ha en sandbox-image med vanliga byggverktyg (Node, Go, Rust, etc.),
bygg den gemensamma imagen:

```bash
scripts/sandbox-common-setup.sh
```

Detta bygger `openclaw-sandbox-common:bookworm-slim`. För att använda den:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Sandbox-webbläsarimage

För att köra webbläsarverktyget i sandboxen, bygg webbläsarimagen:

```bash
scripts/sandbox-browser-setup.sh
```

Detta bygger `openclaw-sandbox-browser:bookworm-slim` med
`Dockerfile.sandbox-browser`. Behållaren kör Krom med CDP aktiverat och
en valfri noVNC-observatör (huvudvärdigt via Xvfb).

Noteringar:

- Headful (Xvfb) minskar bot-blockering jämfört med headless.
- Headless kan fortfarande användas genom att sätta `agents.defaults.sandbox.browser.headless=true`.
- Ingen full skrivbordsmiljö (GNOME) behövs; Xvfb tillhandahåller displayen.

Använd konfig:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

Anpassad webbläsarimage:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

När den är aktiverad får agenten:

- en kontroll-URL för sandbox-webbläsaren (för verktyget `browser`)
- en noVNC-URL (om aktiverad och headless=false)

Kom ihåg: Om du använder en tillåten lista för verktyg, lägg till `browser` (och ta bort den från
deny) eller verktyget förblir blockerat.
Rensa regler (`agents.defaults.sandbox.prune`) gäller även för webbläsarbehållare.

### Anpassad sandbox-image

Bygg din egen image och peka konfig på den:

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### Verktygspolicy (tillåt/neka)

- `deny` vinner över `allow`.
- Om `allow` är tom: alla verktyg (utom nekade) är tillgängliga.
- Om `allow` är icke-tom: endast verktyg i `allow` är tillgängliga (minus nekade).

### Rensningsstrategi

Två reglage:

- `prune.idleHours`: ta bort containrar som inte använts på X timmar (0 = inaktivera)
- `prune.maxAgeDays`: ta bort containrar äldre än X dagar (0 = inaktivera)

Exempel:

- Behåll aktiva sessioner men begränsa livslängden:
  `idleHours: 24`, `maxAgeDays: 7`
- Rensa aldrig:
  `idleHours: 0`, `maxAgeDays: 0`

### Säkerhetsnoteringar

- Hård vägg gäller endast **verktyg** (exec/read/write/edit/apply_patch).
- Verktyg som bara finns på värden, som browser/kamera/canvas, är blockerade som standard.
- Att tillåta `browser` i sandbox **bryter isoleringen** (webbläsaren körs på värden).

## Felsökning

- Image saknas: bygg med [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) eller sätt `agents.defaults.sandbox.docker.image`.
- Container körs inte: den skapas automatiskt per session vid behov.
- Behörighetsfel i sandbox: sätt `docker.user` till ett UID:GID som matchar
  ägarskapet för din monterade arbetsyta (eller chown arbetsytemappen).
- Anpassade verktyg hittades inte: OpenClaw kör kommandon med `sh -lc` (login shell), som
  källor `/etc/profile` och kan återställa PATH. Sätt `docker.env.PATH` till att förkoda dina
  anpassade verktygssökvägar (t.ex. `/custom/bin:/usr/local/share/npm-global/bin`), eller lägg till
  ett skript under `/etc/profile.d/` i din Dockerfile.
