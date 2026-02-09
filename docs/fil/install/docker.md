---
summary: "Opsyonal na Docker-based na setup at onboarding para sa OpenClaw"
read_when:
  - Gusto mo ng isang containerized na gateway sa halip na local installs
  - Vina-validate mo ang Docker flow
title: "Docker"
---

# Docker (opsyonal)

13. **Opsyonal** ang Docker. 14. Gamitin lang ito kung gusto mo ng containerized gateway o para i-validate ang Docker flow.

## Tama ba sa akin ang Docker?

- **Oo**: gusto mo ng isang isolated, pansamantalang gateway environment o patakbuhin ang OpenClaw sa isang host na walang local installs.
- 15. **Hindi**: tumatakbo ka sa sarili mong makina at gusto mo lang ang pinakamabilis na dev loop. 16. Gamitin na lang ang normal na install flow.
- 17. **Paalala sa sandboxing**: gumagamit din ng Docker ang agent sandboxing, pero **hindi** nito kinakailangang tumakbo ang buong gateway sa Docker. Tingnan ang [Hetzner (Docker VPS)](/install/hetzner).

Saklaw ng gabay na ito ang:

- Containerized Gateway (buong OpenClaw sa Docker)
- Per-session Agent Sandbox (host gateway + Docker-isolated na mga tool ng agent)

Mga detalye ng sandboxing: [Sandboxing](/gateway/sandboxing)

## Mga kinakailangan

- Docker Desktop (o Docker Engine) + Docker Compose v2
- Sapat na disk para sa mga image + log

## Containerized Gateway (Docker Compose)

### Mabilis na pagsisimula (inirerekomenda)

Mula sa repo root:

```bash
./docker-setup.sh
```

Ginagawa ng script na ito ang sumusunod:

- bina-build ang gateway image
- pinapatakbo ang onboarding wizard
- nagpi-print ng mga opsyonal na hint sa setup ng provider
- sinisimulan ang gateway gamit ang Docker Compose
- gumagawa ng gateway token at isinusulat ito sa `.env`

Opsyonal na mga env var:

- `OPENCLAW_DOCKER_APT_PACKAGES` — mag-install ng karagdagang apt packages habang bina-build
- `OPENCLAW_EXTRA_MOUNTS` — magdagdag ng karagdagang host bind mounts
- `OPENCLAW_HOME_VOLUME` — i-persist ang `/home/node` sa isang named volume

Pagkatapos nitong matapos:

- Buksan ang `http://127.0.0.1:18789/` sa iyong browser.
- I-paste ang token sa Control UI (Settings → token).
- 19. Kailangan ulit ang URL? 20. Patakbuhin ang `docker compose run --rm openclaw-cli dashboard --no-open`.

Isinusulat nito ang config/workspace sa host:

- `~/.openclaw/`
- `~/.openclaw/workspace`

21. Tumatakbo sa isang VPS? Kung gusto mong mag-persist ang `/home/node` sa mga muling paglikha ng container, magtakda ng isang named
    volume sa pamamagitan ng `OPENCLAW_HOME_VOLUME`.

### Manual na daloy (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

23. Paalala: patakbuhin ang `docker compose ...` mula sa repo root. 24. Kung pinagana mo ang
    `OPENCLAW_EXTRA_MOUNTS` o `OPENCLAW_HOME_VOLUME`, isinusulat ng setup script ang
    `docker-compose.extra.yml`; isama ito kapag nagpapatakbo ng Compose sa ibang lugar:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI token + pairing (Docker)

Kung makita mo ang “unauthorized” o “disconnected (1008): pairing required”, kunin ang
isang bagong dashboard link at aprubahan ang browser device:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Mas detalyado: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Mga dagdag na mount (opsyonal)

25. Kung gusto mong mag-mount ng karagdagang host directories papunta sa mga container, itakda ang
    `OPENCLAW_EXTRA_MOUNTS` bago patakbuhin ang `docker-setup.sh`. 26. Tumatanggap ito ng
    comma-separated na listahan ng Docker bind mounts at ina-apply ang mga ito sa parehong
    `openclaw-gateway` at `openclaw-cli` sa pamamagitan ng pagbuo ng `docker-compose.extra.yml`.

Halimbawa:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Mga tala:

- Kailangang naka-share ang mga path sa Docker Desktop sa macOS/Windows.
- Kung i-e-edit mo ang `OPENCLAW_EXTRA_MOUNTS`, patakbuhin ulit ang `docker-setup.sh` para i-regenerate ang
  extra compose file.
- 27. Nabubuo ang `docker-compose.extra.yml`. 28. Huwag itong mano-manong i-edit.

### I-persist ang buong container home (opsyonal)

Gumamit ng
named volume dito (hindi isang bind path); para sa bind mounts, gamitin ang
`OPENCLAW_EXTRA_MOUNTS`. 30. Gumagawa ito ng Docker volume at mina-mount ito sa
`/home/node`, habang pinananatili ang mga standard config/workspace bind mounts. Ini-install nito ang mga package sa panahon ng image build, kaya nagpe-persist ang mga ito kahit matanggal ang
container.

Halimbawa:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Maaari mo itong pagsamahin sa mga dagdag na mount:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Mga tala:

- Kung babaguhin mo ang `OPENCLAW_HOME_VOLUME`, patakbuhin ulit ang `docker-setup.sh` para i-regenerate ang
  extra compose file.
- Ang named volume ay nananatili hanggang alisin gamit ang `docker volume rm <name>`.

### Mag-install ng karagdagang apt packages (opsyonal)

32. Kung kailangan mo ng mga system package sa loob ng image (halimbawa, build tools o media
    libraries), itakda ang `OPENCLAW_DOCKER_APT_PACKAGES` bago patakbuhin ang `docker-setup.sh`.
    Pinananatili nitong maliit ang attack surface, ngunit nangangahulugan ito na:

Halimbawa:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Mga tala:

- Tumatanggap ito ng space-separated na listahan ng mga apt package name.
- Kung babaguhin mo ang `OPENCLAW_DOCKER_APT_PACKAGES`, patakbuhin ulit ang `docker-setup.sh` para i-rebuild
  ang image.

### Power-user / full-featured na container (opt-in)

34. Ang default Docker image ay **security-first** at tumatakbo bilang non-root na `node`
    user. Tumatakbo ang image bilang `node` (uid 1000).

- walang system package installs sa runtime
- walang Homebrew bilang default
- walang bundled na Chromium/Playwright browsers

Kung gusto mo ng mas full-featured na container, gamitin ang mga opt-in na knob na ito:

1. **I-persist ang `/home/node`** para manatili ang browser downloads at tool caches:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **I-bake ang system deps sa image** (repeatable + persistent):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Mag-install ng Playwright browsers nang walang `npx`** (iniiwasan ang npm override conflicts):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Kung kailangan mong i-install ng Playwright ang system deps, i-rebuild ang image gamit ang
`OPENCLAW_DOCKER_APT_PACKAGES` sa halip na gumamit ng `--with-deps` sa runtime.

4. **I-persist ang Playwright browser downloads**:

- Itakda ang `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` sa
  `docker-compose.yml`.
- Siguraduhing nagpe-persist ang `/home/node` sa pamamagitan ng `OPENCLAW_HOME_VOLUME`, o i-mount ang
  `/home/node/.cache/ms-playwright` gamit ang `OPENCLAW_EXTRA_MOUNTS`.

### Mga permiso + EACCES

Kung makakita ka ng mga error sa pahintulot sa
`/home/node/.openclaw`, tiyaking ang iyong host bind mounts ay pag-aari ng uid 1000. Kung pipiliin mo ang OpenAI Codex OAuth sa wizard, magbubukas ito ng browser URL at susubukang
mahuli ang isang callback sa `http://127.0.0.1:1455/auth/callback`.

Halimbawa (Linux host):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Kung pipiliin mong tumakbo bilang root para sa convenience, tinatanggap mo ang kapalit sa seguridad.

### Mas mabilis na rebuilds (inirerekomenda)

38. Para pabilisin ang mga rebuild, ayusin ang iyong Dockerfile upang ma-cache ang mga dependency layer.
39. Iniiwasan nito ang muling pagpapatakbo ng `pnpm install` maliban kung magbago ang mga lockfile:

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

### Setup ng channel (opsyonal)

Gamitin ang CLI container para i-configure ang mga channel, pagkatapos ay i-restart ang gateway kung kailangan.

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (bot token):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (bot token):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Docs: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (headless Docker)

Kopyahin ang buong redirect
URL na napuntahan mo at i-paste pabalik sa wizard upang tapusin ang auth. 41. Sa Docker o
headless na mga setup, maaaring magpakita ang callback na iyon ng browser error. I-override ang CMD upang ipatupad ang guard.

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

### Mga tala

- Ang Gateway bind ay default sa `lan` para sa paggamit sa container.
- 43. Gumagamit ang Dockerfile CMD ng `--allow-unconfigured`; ang naka-mount na config na may `gateway.mode` na hindi `local` ay magsisimula pa rin. Override CMD to enforce the guard.
- Ang gateway container ang source of truth para sa mga session (`~/.openclaw/agents/<agentId>/sessions/`).

## Agent Sandbox (host gateway + Docker tools)

Mas malalim na talakay: [Sandboxing](/gateway/sandboxing)

### Ano ang ginagawa nito

45. Kapag naka-enable ang `agents.defaults.sandbox`, ang **mga non-main session** ay nagpapatakbo ng mga tool sa loob ng isang Docker
    container. Nanatili ang gateway sa iyong host, ngunit hiwalay ang pagpapatupad ng tool:

- saklaw: `"agent"` bilang default (isang container + workspace bawat agent)
- saklaw: `"session"` para sa per-session isolation
- per-scope na workspace folder na naka-mount sa `/workspace`
- opsyonal na access sa agent workspace (`agents.defaults.sandbox.workspaceAccess`)
- allow/deny na polisiya ng tool (ang deny ang nananalo)
- ang inbound media ay kinokopya sa aktibong sandbox workspace (`media/inbound/*`) para mabasa ng mga tool (kapag may `workspaceAccess: "rw"`, napupunta ito sa agent workspace)

Babala: ang `scope: "shared"` ay hindi pinapagana ang cross-session isolation. Lahat ng session ay nagbabahagi
ng isang container at isang workspace.

### Per-agent na sandbox profile (multi-agent)

Kung gagamit ka ng multi-agent routing, maaaring i-override ng bawat agent ang mga setting ng sandbox + tool:
`agents.list[].sandbox` at `agents.list[].tools` (pati `agents.list[].tools.sandbox.tools`). Pinapayagan ka nitong magpatakbo ng
halo-halong antas ng access sa iisang gateway:

- Buong access (personal agent)
- Read-only na mga tool + read-only na workspace (family/work agent)
- Walang filesystem/shell tools (public agent)

Tingnan ang [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) para sa mga halimbawa,
precedence, at pag-troubleshoot.

### Default na pag-uugali

- Image: `openclaw-sandbox:bookworm-slim`
- Isang container bawat agent
- Access sa agent workspace: `workspaceAccess: "none"` (default) gumagamit ng `~/.openclaw/sandboxes`
  - `"ro"` pinananatili ang sandbox workspace sa `/workspace` at mina-mount ang agent workspace bilang read-only sa `/agent` (nidi-disable ang `write`/`edit`/`apply_patch`)
  - `"rw"` mina-mount ang agent workspace bilang read/write sa `/workspace`
- Auto-prune: idle > 24h O edad > 7d
- Network: `none` bilang default (mag-opt-in nang tahasan kung kailangan mo ng egress)
- Default allow: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- Default deny: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Paganahin ang sandboxing

Kung plano mong mag-install ng mga package sa `setupCommand`, tandaan:

- Ang default na `docker.network` ay `"none"` (walang egress).
- Hinaharangan ng `readOnlyRoot: true` ang pag-install ng mga package.
- Ang `user` ay dapat na root para sa `apt-get` (alisin ang `user` o itakda ang `user: "0:0"`).
  Awtomatikong nire-recreate ng OpenClaw ang mga container kapag nagbago ang `setupCommand` (o docker config)
  maliban kung ang container ay **kamakailan lang ginamit** (sa loob ng ~5 minuto). Ang mga hot container
  ay nagla-log ng babala kasama ang eksaktong `openclaw sandbox recreate ...` na command.

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

Ang mga hardening knob ay nasa ilalim ng `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

Multi-agent: i-override ang `agents.defaults.sandbox.{docker,browser,prune}.*` bawat agent sa pamamagitan ng `agents.list[].sandbox.{docker,browser,prune}.*`
(hindi pinapansin kapag ang `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` ay `"shared"`).

### I-build ang default na sandbox image

```bash
scripts/sandbox-setup.sh
```

Bina-build nito ang `openclaw-sandbox:bookworm-slim` gamit ang `Dockerfile.sandbox`.

### Sandbox common image (opsyonal)

Kung gusto mo ng sandbox image na may karaniwang build tooling (Node, Go, Rust, atbp.), i-build ang common image:

```bash
scripts/sandbox-common-setup.sh
```

Binubuo nito ang `openclaw-sandbox-common:bookworm-slim`. Para gamitin ito:

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

Para patakbuhin ang browser tool sa loob ng sandbox, i-build ang browser image:

```bash
scripts/sandbox-browser-setup.sh
```

Binubuo nito ang `openclaw-sandbox-browser:bookworm-slim` gamit ang
`Dockerfile.sandbox-browser`. Pinapatakbo ng container ang Chromium na may CDP na naka-enable at
isang opsyonal na noVNC observer (headful sa pamamagitan ng Xvfb).

Mga tala:

- Ang headful (Xvfb) ay nagpapababa ng bot blocking kumpara sa headless.
- Maaari pa ring gamitin ang headless sa pamamagitan ng pagtatakda ng `agents.defaults.sandbox.browser.headless=true`.
- Hindi kailangan ng full desktop environment (GNOME); ang Xvfb ang nagbibigay ng display.

Gamitin ang config:

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

Custom na browser image:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

Kapag pinagana, natatanggap ng agent ang:

- isang sandbox browser control URL (para sa `browser` tool)
- isang noVNC URL (kung pinagana at headless=false)

Tandaan: kung gagamit ka ng allowlist para sa mga tool, idagdag ang `browser` (at alisin ito sa
deny) kung hindi ay mananatiling naka-block ang tool.
Ang mga prune rule (`agents.defaults.sandbox.prune`) ay nalalapat din sa mga browser container.

### Custom na sandbox image

Mag-build ng sarili mong image at ituro ang config dito:

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

### Polisiya ng tool (allow/deny)

- Ang `deny` ang nananalo laban sa `allow`.
- Kung walang laman ang `allow`: available ang lahat ng tool (maliban sa deny).
- Kung may laman ang `allow`: tanging ang mga tool sa `allow` ang available (bawas ang deny).

### Diskarte sa pruning

Dalawang knob:

- `prune.idleHours`: alisin ang mga container na hindi nagamit sa X oras (0 = disable)
- `prune.maxAgeDays`: alisin ang mga container na mas luma sa X araw (0 = disable)

Halimbawa:

- Panatilihin ang mga abalang session pero limitahan ang lifetime:
  `idleHours: 24`, `maxAgeDays: 7`
- Huwag kailanman mag-prune:
  `idleHours: 0`, `maxAgeDays: 0`

### Mga tala sa seguridad

- Ang hard wall ay nalalapat lamang sa **mga tool** (exec/read/write/edit/apply_patch).
- Ang mga host-only tool tulad ng browser/camera/canvas ay naka-block bilang default.
- Ang pagpayag sa `browser` sa sandbox ay **sumisira sa isolation** (tumatakbo ang browser sa host).

## Pag-troubleshoot

- Nawawalang image: i-build gamit ang [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) o itakda ang `agents.defaults.sandbox.docker.image`.
- Hindi tumatakbong container: awtomatiko itong gagawin bawat session kapag kailangan.
- Mga error sa permiso sa sandbox: itakda ang `docker.user` sa isang UID:GID na tumutugma sa
  pagmamay-ari ng iyong naka-mount na workspace (o i-chown ang workspace folder).
- Hindi makita ang mga custom tool: Pinapatakbo ng OpenClaw ang mga command gamit ang `sh -lc` (login shell), na
  nagsa-source ng `/etc/profile` at maaaring i-reset ang PATH. Itakda ang `docker.env.PATH` upang i-prepend ang iyong
  mga custom na path ng tool (hal., `/custom/bin:/usr/local/share/npm-global/bin`), o magdagdag
  ng script sa ilalim ng `/etc/profile.d/` sa iyong Dockerfile.
