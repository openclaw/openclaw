---
summary: "Optionele Docker-gebaseerde installatie en onboarding voor OpenClaw"
read_when:
  - Je wilt een gecontaineriseerde gateway in plaats van lokale installaties
  - Je valideert de Docker-flow
title: "Docker"
---

# Docker (optioneel)

Docker is **optioneel**. Gebruik het alleen als je een gecontaineriseerde gateway wilt of de Docker-flow wilt valideren.

## Is Docker geschikt voor mij?

- **Ja**: je wilt een geïsoleerde, wegwerpbare gateway-omgeving of OpenClaw draaien op een host zonder lokale installaties.
- **Nee**: je draait op je eigen machine en wilt gewoon de snelste dev-loop. Gebruik in plaats daarvan de normale installatiestroom.
- **Sandboxing-opmerking**: agent sandboxing gebruikt ook Docker, maar vereist **niet** dat de volledige gateway in Docker draait. Zie [Sandboxing](/gateway/sandboxing).

Deze gids behandelt:

- Gecontaineriseerde Gateway (volledige OpenClaw in Docker)
- Per-sessie Agent Sandbox (host-gateway + Docker-geïsoleerde agent-tools)

Sandboxing-details: [Sandboxing](/gateway/sandboxing)

## Provideropties

- Docker Desktop (of Docker Engine) + Docker Compose v2
- Voldoende schijfruimte voor images + logs

## Gecontaineriseerde Gateway (Docker Compose)

### Snelle start (aanbevolen)

Vanaf de repo-root:

```bash
./docker-setup.sh
```

Dit script:

- bouwt de gateway-image
- draait de onboarding-wizard
- print optionele provider-instellingshints
- start de gateway via Docker Compose
- genereert een gateway-token en schrijft dit naar `.env`

Optionele omgevingsvariabelen:

- `OPENCLAW_DOCKER_APT_PACKAGES` — installeer extra apt-pakketten tijdens het builden
- `OPENCLAW_EXTRA_MOUNTS` — voeg extra host bind mounts toe
- `OPENCLAW_HOME_VOLUME` — behoud `/home/node` in een benoemd volume

Na afloop:

- Open `http://127.0.0.1:18789/` in je browser.
- Plak de token in de Control UI (Instellingen → token).
- De URL opnieuw nodig? Voer `docker compose run --rm openclaw-cli dashboard --no-open` uit.

Het schrijft config/werkruimte op de host:

- `~/.openclaw/`
- `~/.openclaw/workspace`

Draai je op een VPS? Zie [Hetzner (Docker VPS)](/install/hetzner).

### Handmatige flow (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Let op: voer `docker compose ...` uit vanaf de repo-root. Als je
`OPENCLAW_EXTRA_MOUNTS` of `OPENCLAW_HOME_VOLUME` hebt ingeschakeld, schrijft het setupscrip
`docker-compose.extra.yml`; neem dit op wanneer je Compose elders draait:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI-token + koppeling (Docker)

Als je “unauthorized” of “disconnected (1008): pairing required” ziet, haal dan een
nieuwe dashboardlink op en keur het browserapparaat goed:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Meer details: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Extra mounts (optioneel)

Als je extra hostmappen in de containers wilt mounten, stel dan
`OPENCLAW_EXTRA_MOUNTS` in voordat je `docker-setup.sh` uitvoert. Dit accepteert een
door komma’s gescheiden lijst van Docker bind mounts en past ze toe op zowel
`openclaw-gateway` als `openclaw-cli` door `docker-compose.extra.yml` te genereren.

Voorbeeld:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notities:

- Paden moeten gedeeld zijn met Docker Desktop op macOS/Windows.
- Als je `OPENCLAW_EXTRA_MOUNTS` bewerkt, voer `docker-setup.sh` opnieuw uit om het
  extra compose-bestand opnieuw te genereren.
- `docker-compose.extra.yml` wordt gegenereerd. Bewerk dit niet handmatig.

### De volledige container-home behouden (optioneel)

Als je wilt dat `/home/node` behouden blijft bij het opnieuw aanmaken van containers,
stel dan een benoemd volume in via `OPENCLAW_HOME_VOLUME`. Dit maakt een Docker-volume aan en mount
het op `/home/node`, terwijl de standaard config/werkruimte bind mounts behouden blijven. Gebruik hier een benoemd volume (geen bind-pad); voor bind mounts gebruik je
`OPENCLAW_EXTRA_MOUNTS`.

Voorbeeld:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Je kunt dit combineren met extra mounts:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notities:

- Als je `OPENCLAW_HOME_VOLUME` wijzigt, voer `docker-setup.sh` opnieuw uit om het
  extra compose-bestand opnieuw te genereren.
- Het benoemde volume blijft bestaan totdat het wordt verwijderd met `docker volume rm <name>`.

### Extra apt-pakketten installeren (optioneel)

Als je systeempakketten in de image nodig hebt (bijvoorbeeld buildtools of
medialibraries), stel dan `OPENCLAW_DOCKER_APT_PACKAGES` in voordat je `docker-setup.sh` uitvoert.
Dit installeert de pakketten tijdens het builden van de image, zodat ze blijven bestaan
zelfs als de container wordt verwijderd.

Voorbeeld:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Notities:

- Dit accepteert een door spaties gescheiden lijst van apt-pakketnamen.
- Als je `OPENCLAW_DOCKER_APT_PACKAGES` wijzigt, voer `docker-setup.sh` opnieuw uit om de image
  opnieuw te bouwen.

### Power-user / volledig uitgeruste container (opt-in)

De standaard Docker-image is **security-first** en draait als de niet-root
`node`-gebruiker. Dit houdt het aanvalsoppervlak klein, maar betekent:

- geen installatie van systeempakketten tijdens runtime
- standaard geen Homebrew
- geen gebundelde Chromium/Playwright-browsers

Als je een meer volledig uitgeruste container wilt, gebruik dan deze opt-in opties:

1. **Behoud `/home/node`** zodat browserdownloads en toolcaches behouden blijven:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Bak systeemafhankelijkheden in de image** (herhaalbaar + persistent):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Installeer Playwright-browsers zonder `npx`** (vermijdt npm override-conflicten):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Als je wilt dat Playwright systeemafhankelijkheden installeert, bouw de image opnieuw met
`OPENCLAW_DOCKER_APT_PACKAGES` in plaats van `--with-deps` tijdens runtime te gebruiken.

4. **Behoud Playwright-browserdownloads**:

- Stel `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` in
  `docker-compose.yml` in.
- Zorg dat `/home/node` behouden blijft via `OPENCLAW_HOME_VOLUME`, of mount
  `/home/node/.cache/ms-playwright` via `OPENCLAW_EXTRA_MOUNTS`.

### Rechten + EACCES

De image draait als `node` (uid 1000). Als je permissiefouten ziet op
`/home/node/.openclaw`, zorg er dan voor dat je host bind mounts eigendom zijn van uid 1000.

Voorbeeld (Linux-host):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Als je ervoor kiest om voor het gemak als root te draaien, accepteer je het
beveiligingscompromis.

### Snellere rebuilds (aanbevolen)

Om rebuilds te versnellen, orden je Dockerfile zo dat afhankelijkheidslagen
gecached worden.
Dit voorkomt het opnieuw uitvoeren van `pnpm install` tenzij
lockfiles veranderen:

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

### Kanaalinstellingen (optioneel)

Gebruik de CLI-container om kanalen te configureren en herstart daarna indien nodig
de gateway.

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

Documentatie: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (headless Docker)

Als je OpenAI Codex OAuth kiest in de wizard, opent deze een browser-URL en probeert
een callback vast te leggen op `http://127.0.0.1:1455/auth/callback`. In Docker- of headless-opstellingen
kan die callback een browserfout tonen. Kopieer de volledige redirect-URL waarop je
uitkomt en plak die terug in de wizard om de authenticatie te voltooien.

### Health check

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E smoke test (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR-import smoke test (Docker)

```bash
pnpm test:docker:qr
```

### Notities

- Gateway bindt standaard aan `lan` voor containergebruik.
- Dockerfile CMD gebruikt `--allow-unconfigured`; gemounte config met `gateway.mode` en niet
  `local` start nog steeds. Overschrijf CMD om de guard af te dwingen.
- De gateway-container is de bron van waarheid voor sessies (`~/.openclaw/agents/<agentId>/sessions/`).

## Agent Sandbox (host-gateway + Docker-tools)

Verdieping: [Sandboxing](/gateway/sandboxing)

### Wat het doet

Wanneer `agents.defaults.sandbox` is ingeschakeld, draaien **niet-hoofdsessies** tools binnen
een Docker-container. De gateway blijft op je host, maar de tooluitvoering is geïsoleerd:

- scope: standaard `"agent"` (één container + werkruimte per agent)
- scope: `"session"` voor per-sessie-isolatie
- per-scope werkruimtemap gemount op `/workspace`
- optionele toegang tot agent-werkruimte (`agents.defaults.sandbox.workspaceAccess`)
- allow/deny-toolbeleid (deny wint)
- inkomende media wordt gekopieerd naar de actieve sandbox-werkruimte (`media/inbound/*`)
  zodat tools het kunnen lezen (met `workspaceAccess: "rw"` komt dit in de agent-werkruimte terecht)

Waarschuwing: `scope: "shared"` schakelt isolatie tussen sessies uit. Alle sessies delen
één container en één werkruimte.

### Per-agent sandboxprofielen (multi-agent)

Als je multi-agent routing gebruikt, kan elke agent sandbox- en toolinstellingen
overschrijven: `agents.list[].sandbox` en `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools`). Dit laat je
gemengde toegangsniveaus in één gateway draaien:

- Volledige toegang (persoonlijke agent)
- Alleen-lezen tools + alleen-lezen werkruimte (familie/werkagent)
- Geen filesystem/shell-tools (publieke agent)

Zie [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) voor voorbeelden,
precedentie en probleemoplossing.

### Standaardgedrag

- Image: `openclaw-sandbox:bookworm-slim`
- Eén container per agent
- Toegang tot agent-werkruimte: `workspaceAccess: "none"` (standaard) gebruikt `~/.openclaw/sandboxes`
  - `"ro"` houdt de sandbox-werkruimte op `/workspace` en mount de agent-werkruimte
    alleen-lezen op `/agent` (schakelt `write`/`edit`/`apply_patch` uit)
  - `"rw"` mount de agent-werkruimte lees/schrijf op `/workspace`
- Automatisch opruimen: inactief > 24u OF leeftijd > 7d
- Netwerk: standaard `none` (expliciet opt-in als je egress nodig hebt)
- Standaard toegestaan: `exec`, `process`, `read`, `write`,
  `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- Standaard geweigerd: `browser`, `canvas`, `nodes`, `cron`,
  `discord`, `gateway`

### Sandboxing inschakelen

Als je van plan bent pakketten te installeren in `setupCommand`, let dan op:

- Standaard `docker.network` is `"none"` (geen egress).
- `readOnlyRoot: true` blokkeert pakketinstallaties.
- `user` moet root zijn voor `apt-get` (laat `user` weg of stel `user: "0:0"` in).
  OpenClaw maakt containers automatisch opnieuw aan wanneer `setupCommand` (of docker-config)
  verandert, tenzij de container **recent is gebruikt** (binnen ~5 minuten). Hete containers
  loggen een waarschuwing met het exacte `openclaw sandbox recreate ...`-commando.

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

Verhardingsopties staan onder `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`,
`cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`, `dns`,
`extraHosts`.

Multi-agent: overschrijf `agents.defaults.sandbox.{docker,browser,prune}.*` per agent via `agents.list[].sandbox.{docker,browser,prune}.*`
(genegeerd wanneer `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` `"shared"` is).

### De standaard sandbox-image bouwen

```bash
scripts/sandbox-setup.sh
```

Dit bouwt `openclaw-sandbox:bookworm-slim` met `Dockerfile.sandbox`.

### Sandbox common image (optioneel)

Als je een sandbox-image wilt met veelgebruikte buildtooling (Node, Go, Rust, enz.),
bouw dan de common image:

```bash
scripts/sandbox-common-setup.sh
```

Dit bouwt `openclaw-sandbox-common:bookworm-slim`. Om deze te gebruiken:

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

Om de browser-tool binnen de sandbox te draaien, bouw je de browser-image:

```bash
scripts/sandbox-browser-setup.sh
```

Dit bouwt `openclaw-sandbox-browser:bookworm-slim` met
`Dockerfile.sandbox-browser`. De container draait Chromium met CDP ingeschakeld en
een optionele noVNC-observer (headful via Xvfb).

Notities:

- Headful (Xvfb) vermindert botblokkering ten opzichte van headless.
- Headless kan nog steeds worden gebruikt door `agents.defaults.sandbox.browser.headless=true` in te stellen.
- Geen volledige desktopomgeving (GNOME) nodig; Xvfb levert het display.

Gebruik config:

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

Aangepaste browser-image:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

Wanneer ingeschakeld ontvangt de agent:

- een sandbox-browsercontrol-URL (voor de `browser`-tool)
- een noVNC-URL (indien ingeschakeld en headless=false)

Onthoud: als je een toegestane lijst voor tools gebruikt, voeg `browser` toe
(en verwijder het uit deny), anders blijft de tool geblokkeerd.
Opruimregels (`agents.defaults.sandbox.prune`) zijn ook van toepassing op browsercontainers.

### Aangepaste sandbox-image

Bouw je eigen image en wijs de config ernaar:

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

### Toolbeleid (allow/deny)

- `deny` wint van `allow`.
- Als `allow` leeg is: alle tools (behalve deny) zijn beschikbaar.
- Als `allow` niet leeg is: alleen tools in `allow` zijn beschikbaar (minus deny).

### Opruimstrategie

Twee knoppen:

- `prune.idleHours`: verwijder containers die X uur niet zijn gebruikt (0 = uitschakelen)
- `prune.maxAgeDays`: verwijder containers ouder dan X dagen (0 = uitschakelen)

Voorbeeld:

- Houd drukke sessies, maar begrens de levensduur:
  `idleHours: 24`, `maxAgeDays: 7`
- Nooit opruimen:
  `idleHours: 0`, `maxAgeDays: 0`

### Beveiligingsnotities

- Harde isolatie geldt alleen voor **tools** (exec/read/write/edit/apply_patch).
- Alleen-host-tools zoals browser/camera/canvas zijn standaard geblokkeerd.
- Toestaan van `browser` in de sandbox **doorbreekt isolatie** (browser draait op de host).

## Problemen oplossen

- Image ontbreekt: bouw met [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) of stel `agents.defaults.sandbox.docker.image` in.
- Container draait niet: wordt automatisch per sessie aangemaakt wanneer nodig.
- Permissiefouten in sandbox: stel `docker.user` in op een UID:GID die overeenkomt
  met het eigendom van je gemounte werkruimte (of chown de werkruimtemap).
- Aangepaste tools niet gevonden: OpenClaw voert commando’s uit met `sh -lc`
  (login shell), die `/etc/profile` sourced en mogelijk PATH reset. Stel `docker.env.PATH`
  in om je aangepaste toolpaden vooraan toe te voegen (bijv. `/custom/bin:/usr/local/share/npm-global/bin`), of voeg
  een script toe onder `/etc/profile.d/` in je Dockerfile.
