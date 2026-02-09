---
summary: "Valgfri Docker-baseret opsætning og introduktion til OpenClaw"
read_when:
  - Du vil have en containeriseret gateway i stedet for lokale installationer
  - Du validerer Docker-flowet
title: "Docker"
---

# Docker (valgfri)

Docker er **valgfri**. Brug den kun, hvis du vil have en containerized gateway eller til at validere Docker-flowet.

## Er Docker det rigtige for mig?

- **Ja**: du vil have et isoleret, midlertidigt gateway-miljø eller køre OpenClaw på en vært uden lokale installationer.
- \*\*Nej \*\*: Du kører på din egen maskine og vil blot have den hurtigste dev loop. Brug i stedet det normale installationsflow.
- \*\*Sandboxing note **: agent sandboxing bruger også Docker men det gør \*\* ikke** kræver den fulde gateway til at køre i Docker. Se [Sandboxing](/gateway/sandboxing).

Denne guide dækker:

- Containeriseret Gateway (fuld OpenClaw i Docker)
- Per-session Agent Sandbox (gateway på værten + Docker-isolerede agentværktøjer)

Sandboxing-detaljer: [Sandboxing](/gateway/sandboxing)

## Krav

- Docker Desktop (eller Docker Engine) + Docker Compose v2
- Nok diskplads til images + logs

## Containeriseret Gateway (Docker Compose)

### Hurtig start (anbefalet)

Fra repo-roden:

```bash
./docker-setup.sh
```

Dette script:

- bygger gateway-imaget
- kører onboarding-opsætningsguiden
- udskriver valgfrie hints til udbyderopsætning
- starter gatewayen via Docker Compose
- genererer en gateway-token og skriver den til `.env`

Valgfrie miljøvariabler:

- `OPENCLAW_DOCKER_APT_PACKAGES` — installér ekstra apt-pakker under build
- `OPENCLAW_EXTRA_MOUNTS` — tilføj ekstra host bind mounts
- `OPENCLAW_HOME_VOLUME` — bevar `/home/node` i et navngivet volume

Når den er færdig:

- Åbn `http://127.0.0.1:18789/` i din browser.
- Indsæt token i Control UI (Settings → token).
- Har du brug for URL igen? Kør `docker komponere kør --rm openclaw-cli dashboard --no-open`.

Den skriver konfiguration/arbejdsområde på værten:

- `~/.openclaw/`
- `~/.openclaw/workspace`

Kører på en VPS? See [Hetzner (Docker VPS)](/install/hetzner).

### Manuel flow (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Bemærk: Kør `docker komponere ...` fra repo roden. Hvis du har aktiveret
`OPENCLAW_EXTRA_MOUNTS` eller `OPENCLAW_HOME_VOLUME`, skriver installationsscriptet
`docker-compose.extra.yml`; inkluder det når du kører Compose andetsteds:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI-token + parring (Docker)

Hvis du ser “unauthorized” eller “disconnected (1008): pairing required”, så hent et
friskt dashboard-link og godkend browser-enheden:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Flere detaljer: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Ekstra mounts (valgfrit)

Hvis du ønsker at montere yderligere værtsmapper i containerne, så angiv
`OPENCLAW_EXTRA_MOUNTS` før du kører `docker-setup.sh`. Dette accepterer en
kommasepareret liste af Docker bind mounts og anvender dem til både
`openclaw-gateway` og `openclaw-cli` ved at generere `docker-compose.extra.yml`.

Eksempel:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Noter:

- Stier skal være delt med Docker Desktop på macOS/Windows.
- Hvis du redigerer `OPENCLAW_EXTRA_MOUNTS`, så genkør `docker-setup.sh` for at regenerere
  den ekstra compose-fil.
- `docker-compose.extra.yml` er genereret. Må ikke hånd-redigere det.

### Bevar hele containerens home (valgfrit)

Hvis du vil have `/home/node` til at fortsætte på tværs af container rekreation, indstille en opkaldt
volumen via `OPENCLAW_HOME_VOLUME`. Dette skaber en Docker volumen og monterer det på
`/home/node`, samtidig med at standard config/workspace binder mounts. Brug et
navngivet volumen her (ikke en bindingssti); til bind mounts, brug
`OPENCLAW_EXTRA_MOUNTS`.

Eksempel:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Du kan kombinere dette med ekstra mounts:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Noter:

- Hvis du ændrer `OPENCLAW_HOME_VOLUME`, så genkør `docker-setup.sh` for at regenerere
  den ekstra compose-fil.
- Det navngivne volume bevares, indtil det fjernes med `docker volume rm <name>`.

### Installér ekstra apt-pakker (valgfrit)

Hvis du har brug for systempakker inde i billedet (for eksempel, bygge værktøjer eller medier
biblioteker), sæt `OPENCLAW_DOCKER_APT_not. ES` før du kører `docker-setup.sh`.
Dette installerer pakkerne under billedbygningen, så de fortsætter selvom
-beholderen slettes.

Eksempel:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Noter:

- Dette accepterer en plads-separeret liste af apt-pakkenavne.
- Hvis du ændrer `OPENCLAW_DOCKER_APT_PACKAGES`, så genkør `docker-setup.sh` for at genbygge
  imaget.

### Power-user / fuldt udstyret container (tilvalg)

Standard Docker-billedet er **sikkerhed-først** og kører som ikke-root `node`
bruger. Dette holder angrebet overflade lille, men det betyder:

- ingen installation af systempakker ved runtime
- ingen Homebrew som standard
- ingen medfølgende Chromium/Playwright-browsere

Hvis du vil have en mere fuldt udstyret container, så brug disse tilvalg:

1. **Bevar `/home/node`** så browser-downloads og værktøjscaches overlever:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Bag systemafhængigheder ind i imaget** (reproducerbart + vedvarende):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Installér Playwright-browsere uden `npx`** (undgår npm override-konflikter):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Hvis du har brug for, at Playwright installerer systemafhængigheder, så genbyg imaget med
`OPENCLAW_DOCKER_APT_PACKAGES` i stedet for at bruge `--with-deps` ved runtime.

4. **Bevar Playwright browser-downloads**:

- Sæt `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` i
  `docker-compose.yml`.
- Sørg for, at `/home/node` bevares via `OPENCLAW_HOME_VOLUME`, eller montér
  `/home/node/.cache/ms-playwright` via `OPENCLAW_EXTRA_MOUNTS`.

### Rettigheder + EACCES

Billedet kører som 'node' (uid 1000). Hvis du ser tilladelsesfejl på
`/home/node/.openclaw`, sørg for at din vært bind mounts er ejet af uid 1000.

Eksempel (Linux-vært):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Hvis du vælger at køre som root for bekvemmelighed, accepterer du sikkerhedskompromisset.

### Hurtigere rebuilds (anbefalet)

For at fremskynde genopbygningen, bestilles din Dockerfile så afhængighedslag cached.
Dette undgår genkørsel `pnpm install` medmindre lockfiles ændres:

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

### Kanalopsætning (valgfrit)

Brug CLI-containeren til at konfigurere kanaler, og genstart derefter gatewayen om nødvendigt.

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

Hvis du vælger OpenAI Codex OAuth i guiden, åbner den en browser URL og forsøger
at tage et opkald tilbage på `http://127.0.0.1:1455/auth/callback`. I Docker eller
headless opsætninger, der tilbagekald kan vise en browser fejl. Kopier den fulde omdirigering
URL, du lander på, og indsæt den tilbage i guiden for at afslutte auth.

### Health check

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E smoke test (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR import smoke test (Docker)

```bash
pnpm test:docker:qr
```

### Noter

- Gateway bind bruger som standard `lan` til containerbrug.
- Dockerfile CMD bruger `-- allow-unconfigured`; monteret konfiguration med `gateway.mode` ikke `local` vil stadig starte. Tilsidesæt CMD for at håndhæve vagten.
- Gateway-containeren er sandhedskilden for sessioner (`~/.openclaw/agents/<agentId>/sessions/`).

## Agent Sandbox (gateway på værten + Docker-værktøjer)

Dybdegående: [Sandboxing](/gateway/sandboxing)

### Hvad den gør

Når `agents.defaults.sandbox` er aktiveret, kør **ikke-hovedsessioner** værktøjer inde i en Docker
container. Porten forbliver på din vært, men værktøjets udførelse er isoleret:

- scope: `"agent"` som standard (én container + arbejdsområde pr. agent)
- scope: `"session"` for per-session-isolering
- arbejdsområdemappe pr. scope monteret på `/workspace`
- valgfri adgang til agent-arbejdsområde (`agents.defaults.sandbox.workspaceAccess`)
- allow/deny-værktøjspolitik (deny vinder)
- indgående medier kopieres ind i det aktive sandbox-arbejdsområde (`media/inbound/*`), så værktøjer kan læse det (med `workspaceAccess: "rw"` lander dette i agent-arbejdsområdet)

Advarsel: `scope: "delt"` deaktiverer isolering på tværs af sessioner. Alle sessioner deler
en beholder og et arbejdsområde.

### Per-agent sandbox-profiler (multi-agent)

Hvis du bruger multi-agent routing, kan hver agent tilsidesætte sandkasse + værktøj indstillinger:
`agents.list[].sandbox` og `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools`). Dette lader dig køre
blandede adgangsniveauer i én gateway:

- Fuld adgang (personlig agent)
- Skrivebeskyttede værktøjer + skrivebeskyttet arbejdsområde (familie-/arbejdsagent)
- Ingen filsystem-/shell-værktøjer (offentlig agent)

Se [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for eksempler,
præcedens og fejlfinding.

### Standardadfærd

- Image: `openclaw-sandbox:bookworm-slim`
- Én container pr. agent
- Agent-arbejdsområdeadgang: `workspaceAccess: "none"` (standard) bruger `~/.openclaw/sandboxes`
  - `"ro"` holder sandbox-arbejdsområdet på `/workspace` og monterer agent-arbejdsområdet skrivebeskyttet på `/agent` (deaktiverer `write`/`edit`/`apply_patch`)
  - `"rw"` monterer agent-arbejdsområdet læse/skrive på `/workspace`
- Auto-prune: idle > 24 t ELLER alder > 7 dage
- Netværk: `none` som standard (tilvælg eksplicit, hvis du har brug for egress)
- Standard allow: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- Standard deny: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Aktivér sandboxing

Hvis du planlægger at installere pakker i `setupCommand`, så bemærk:

- Standard `docker.network` er `"none"` (ingen egress).
- `readOnlyRoot: true` blokerer pakkeinstallationer.
- `user` skal være root for `apt-get` (undlad `user` eller sæt `user: "0:0"`).
  OpenClaw automatisk genskaber containere, når `setupCommand` (eller docker config) ændrer
  , medmindre beholderen er **nyligt brugt** (inden for ~5 minutter). Hot containere
  logge en advarsel med den nøjagtige `openclaw sandkasse genskabe ...` kommando.

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

Hardening-knapper findes under `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

Multi-agent: tilsidesæt `agents.defaults.sandbox.{docker,browser,prune}.*` pr. agent via `agents.list[].sandbox.{docker,browser,prune}.*`
(ignoreres, når `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` er `"shared"`).

### Byg standard sandbox-image

```bash
scripts/sandbox-setup.sh
```

Dette bygger `openclaw-sandbox:bookworm-slim` ved hjælp af `Dockerfile.sandbox`.

### Sandbox common image (valgfrit)

Hvis du vil have et sandbox-image med almindelige build-værktøjer (Node, Go, Rust osv.), så byg common-imaget:

```bash
scripts/sandbox-common-setup.sh
```

Dette bygger `openclaw-sandkasse-common:bogorm-slim`. For at bruge det:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Sandbox browser image

For at køre browser-værktøjet inde i sandboxen, byg browser-imaget:

```bash
scripts/sandbox-browser-setup.sh
```

Dette bygger `openclaw-sandbox-browser:bookworm-slim` ved hjælp af
`Dockerfile.sandbox-browser`. Beholderen kører Chromium med CDP aktiveret og
en valgfri noVNC observatør (headful via Xvfb).

Noter:

- Headful (Xvfb) reducerer bot-blokering vs. headless.
- Headless kan stadig bruges ved at sætte `agents.defaults.sandbox.browser.headless=true`.
- Intet fuldt desktop-miljø (GNOME) er nødvendigt; Xvfb leverer displayet.

Brug konfiguration:

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

Brugerdefineret browser-image:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

Når aktiveret, modtager agenten:

- en sandbox browser-kontrol-URL (til `browser`-værktøjet)
- en noVNC-URL (hvis aktiveret og headless=false)

Husk: Hvis du bruger en tilladt liste for værktøjer, tilføj `browser` (og fjern den fra
benægt), eller værktøjet forbliver blokeret.
Fortryd regler (`agents.defaults.sandbox.prune`) gælder også for browsercontainere.

### Brugerdefineret sandbox-image

Byg dit eget image og peg konfigurationen på det:

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

### Værktøjspolitik (allow/deny)

- `deny` vinder over `allow`.
- Hvis `allow` er tom: alle værktøjer (undtagen deny) er tilgængelige.
- Hvis `allow` ikke er tom: kun værktøjer i `allow` er tilgængelige (minus deny).

### Pruning-strategi

To knapper:

- `prune.idleHours`: fjern containere, der ikke er brugt i X timer (0 = deaktiver)
- `prune.maxAgeDays`: fjern containere ældre end X dage (0 = deaktiver)

Eksempel:

- Behold travle sessioner men begræns levetiden:
  `idleHours: 24`, `maxAgeDays: 7`
- Aldrig prune:
  `idleHours: 0`, `maxAgeDays: 0`

### Sikkerhedsnoter

- Hard wall gælder kun for **værktøjer** (exec/read/write/edit/apply_patch).
- Host-only værktøjer som browser/kamera/canvas er blokeret som standard.
- At tillade `browser` i sandbox **bryder isolation** (browseren kører på værten).

## Fejlfinding

- Image mangler: byg med [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) eller sæt `agents.defaults.sandbox.docker.image`.
- Container kører ikke: den oprettes automatisk pr. session efter behov.
- Rettighedsfejl i sandbox: sæt `docker.user` til en UID:GID, der matcher ejerskabet af dit
  monterede arbejdsområde (eller chown arbejdsområdemappen).
- Brugerdefinerede værktøjer ikke fundet: OpenClaw kører kommandoer med `sh -lc` (login shell), som
  kilder `/etc/profile` og kan nulstille PATH. Sæt `docker.env.PATH` til at forberede dine
  brugerdefinerede værktøjsstier (f.eks. `/custom/bin:/usr/local/share/npm-global/bin`), eller tilføj
  et script under `/etc/profile.d/` i din Dockerfile.
