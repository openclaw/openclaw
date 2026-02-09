---
summary: "Opcjonalna konfiguracja i onboarding oparty na Dockerze dla OpenClaw"
read_when:
  - Chcesz użyć konteneryzowanej bramy zamiast instalacji lokalnych
  - Weryfikujesz przepływ pracy z Dockerem
title: "Docker"
---

# Docker (opcjonalnie)

Docker jest **opcjonalny**. Używaj go tylko wtedy, gdy chcesz konteneryzowaną bramę lub zweryfikować przepływ pracy z Dockerem.

## Czy Docker jest dla mnie?

- **Tak**: chcesz odizolowane, tymczasowe środowisko bramy albo uruchamiać OpenClaw na hoście bez instalacji lokalnych.
- **Nie**: pracujesz na własnym komputerze i zależy Ci na najszybszej pętli developerskiej. Zamiast tego użyj standardowego procesu instalacji.
- **Uwaga dotycząca sandboxingu**: sandboxing agentów również używa Dockera, ale **nie** wymaga uruchamiania całej bramy w Dockerze. Zobacz [Sandboxing](/gateway/sandboxing).

Ten przewodnik obejmuje:

- Konteneryzowaną bramę (pełny OpenClaw w Dockerze)
- Sandbox agenta na sesję (host bramy + narzędzia agentów izolowane w Dockerze)

Szczegóły sandboxingu: [Sandboxing](/gateway/sandboxing)

## Wymagania

- Docker Desktop (lub Docker Engine) + Docker Compose v2
- Wystarczająca ilość miejsca na dysku na obrazy + logi

## Konteneryzowana brama (Docker Compose)

### Szybki start (zalecane)

Z repozytorium:

```bash
./docker-setup.sh
```

Ten skrypt:

- buduje obraz bramy
- uruchamia kreator onboardingu
- wyświetla opcjonalne wskazówki konfiguracji dostawców
- uruchamia bramę przez Docker Compose
- generuje token bramy i zapisuje go do `.env`

Opcjonalne zmienne środowiskowe:

- `OPENCLAW_DOCKER_APT_PACKAGES` — instaluj dodatkowe pakiety apt podczas budowania
- `OPENCLAW_EXTRA_MOUNTS` — dodaj dodatkowe bind mounty hosta
- `OPENCLAW_HOME_VOLUME` — utrwal `/home/node` w nazwanym wolumenie

Po zakończeniu:

- Otwórz `http://127.0.0.1:18789/` w przeglądarce.
- Wklej token w interfejsie Control UI (Ustawienia → token).
- Potrzebujesz ponownie adresu URL? Uruchom `docker compose run --rm openclaw-cli dashboard --no-open`.

Konfiguracja/obszar roboczy są zapisywane na hoście:

- `~/.openclaw/`
- `~/.openclaw/workspace`

Uruchamiasz na VPS? Zobacz [Hetzner (Docker VPS)](/install/hetzner).

### Ręczny przepływ (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Uwaga: uruchom `docker compose ...` z katalogu głównego repozytorium. Jeśli włączyłeś
`OPENCLAW_EXTRA_MOUNTS` lub `OPENCLAW_HOME_VOLUME`, skrypt konfiguracji zapisze
`docker-compose.extra.yml`; dołącz go podczas uruchamiania Compose w innym miejscu:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Token Control UI + parowanie (Docker)

Jeśli widzisz „unauthorized” lub „disconnected (1008): pairing required”, pobierz
świeży link do panelu i zatwierdź urządzenie przeglądarki:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Więcej informacji: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Dodatkowe mounty (opcjonalnie)

Jeśli chcesz zamontować dodatkowe katalogi hosta do kontenerów, ustaw
`OPENCLAW_EXTRA_MOUNTS` przed uruchomieniem `docker-setup.sh`. Akceptuje to
rozdzielaną przecinkami listę bind mountów Dockera i stosuje je do
`openclaw-gateway` oraz `openclaw-cli`, generując `docker-compose.extra.yml`.

Przykład:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Uwagi:

- Ścieżki muszą być udostępnione Docker Desktop na macOS/Windows.
- Jeśli edytujesz `OPENCLAW_EXTRA_MOUNTS`, uruchom ponownie `docker-setup.sh`, aby wygenerować
  dodatkowy plik compose.
- `docker-compose.extra.yml` jest generowany. Nie edytuj go ręcznie.

### Utrwalenie całego katalogu domowego kontenera (opcjonalnie)

Jeśli chcesz, aby `/home/node` przetrwał ponowne tworzenie kontenera, ustaw nazwany
wolumen przez `OPENCLAW_HOME_VOLUME`. Spowoduje to utworzenie wolumenu Dockera i zamontowanie go w
`/home/node`, przy jednoczesnym zachowaniu standardowych bind mountów konfiguracji/obszaru roboczego. Użyj tutaj
nazwanego wolumenu (nie ścieżki bind); dla bind mountów użyj
`OPENCLAW_EXTRA_MOUNTS`.

Przykład:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Możesz to połączyć z dodatkowymi mountami:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Uwagi:

- Jeśli zmienisz `OPENCLAW_HOME_VOLUME`, uruchom ponownie `docker-setup.sh`, aby wygenerować
  dodatkowy plik compose.
- Nazwany wolumen pozostaje do czasu usunięcia poleceniem `docker volume rm <name>`.

### Instalacja dodatkowych pakietów apt (opcjonalnie)

Jeśli potrzebujesz pakietów systemowych w obrazie (np. narzędzi do budowania lub
bibliotek multimedialnych), ustaw `OPENCLAW_DOCKER_APT_PACKAGES` przed uruchomieniem
`docker-setup.sh`.
Pakiety są instalowane podczas budowania obrazu, więc pozostają nawet po usunięciu
kontenera.

Przykład:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Uwagi:

- Akceptowana jest lista nazw pakietów apt rozdzielona spacjami.
- Jeśli zmienisz `OPENCLAW_DOCKER_APT_PACKAGES`, uruchom ponownie `docker-setup.sh`, aby przebudować
  obraz.

### Tryb zaawansowany / pełnofunkcyjny kontener (opt-in)

Domyślny obraz Dockera jest **nastawiony na bezpieczeństwo** i działa jako nie-rootowy użytkownik `node`. Zmniejsza to powierzchnię ataku, ale oznacza:

- brak instalacji pakietów systemowych w czasie działania
- brak Homebrew domyślnie
- brak dołączonych przeglądarek Chromium/Playwright

Jeśli chcesz bardziej pełnofunkcyjny kontener, użyj tych opcji opt-in:

1. **Utrwal `/home/node`**, aby pobrania przeglądarek i cache narzędzi przetrwały:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Wypiecz zależności systemowe w obrazie** (powtarzalne + trwałe):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Zainstaluj przeglądarki Playwright bez `npx`** (unika konfliktów nadpisywania npm):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Jeśli potrzebujesz, aby Playwright instalował zależności systemowe, przebuduj obraz z
`OPENCLAW_DOCKER_APT_PACKAGES` zamiast używać `--with-deps` w czasie działania.

4. **Utrwal pobrania przeglądarek Playwright**:

- Ustaw `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` w
  `docker-compose.yml`.
- Upewnij się, że `/home/node` jest utrwalone przez `OPENCLAW_HOME_VOLUME`, albo zamontuj
  `/home/node/.cache/ms-playwright` przez `OPENCLAW_EXTRA_MOUNTS`.

### Uprawnienia + EACCES

Obraz działa jako `node` (uid 1000). Jeśli widzisz błędy uprawnień na
`/home/node/.openclaw`, upewnij się, że bind mounty hosta należą do uid 1000.

Przykład (host Linux):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Jeśli zdecydujesz się uruchamiać jako root dla wygody, akceptujesz kompromis bezpieczeństwa.

### Szybsze przebudowy (zalecane)

Aby przyspieszyć przebudowy, uporządkuj Dockerfile tak, aby warstwy zależności były buforowane.
Pozwala to uniknąć ponownego uruchamiania `pnpm install`, o ile nie zmienią się pliki lock:

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

### Konfiguracja kanałów (opcjonalnie)

Użyj kontenera CLI do skonfigurowania kanałów, a następnie w razie potrzeby zrestartuj bramę.

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (token bota):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (token bota):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Dokumentacja: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (Docker bez interfejsu)

Jeśli w kreatorze wybierzesz OpenAI Codex OAuth, otworzy on adres URL w przeglądarce i spróbuje
przechwycić callback na `http://127.0.0.1:1455/auth/callback`. W Dockerze lub konfiguracjach
bez interfejsu callback może wyświetlić błąd przeglądarki. Skopiuj pełny adres URL przekierowania,
na którym wylądujesz, i wklej go z powrotem do kreatora, aby zakończyć uwierzytelnianie.

### Kontrola zdrowia

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### Test dymny E2E (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### Test dymny importu QR (Docker)

```bash
pnpm test:docker:qr
```

### Uwagi

- Bind bramy domyślnie wiąże się z `lan` do użycia w kontenerze.
- CMD w Dockerfile używa `--allow-unconfigured`; zamontowana konfiguracja z `gateway.mode`, a nie `local`, nadal się uruchomi. Nadpisz CMD, aby wymusić strażnika.
- Kontener bramy jest źródłem prawdy dla sesji (`~/.openclaw/agents/<agentId>/sessions/`).

## Sandbox agenta (host bramy + narzędzia Docker)

Dogłębnie: [Sandboxing](/gateway/sandboxing)

### Co to robi

Gdy włączone jest `agents.defaults.sandbox`, **sesje inne niż główna** uruchamiają narzędzia wewnątrz kontenera
Dockera. Brama pozostaje na hoście, ale wykonanie narzędzi jest izolowane:

- zakres: `"agent"` domyślnie (jeden kontener + obszar roboczy na agenta)
- zakres: `"session"` dla izolacji na sesję
- katalog obszaru roboczego na zakres montowany w `/workspace`
- opcjonalny dostęp do obszaru roboczego agenta (`agents.defaults.sandbox.workspaceAccess`)
- polityka narzędzi allow/deny (deny ma pierwszeństwo)
- media przychodzące są kopiowane do aktywnego obszaru roboczego sandboxa (`media/inbound/*`), aby narzędzia mogły je czytać (z `workspaceAccess: "rw"` trafia to do obszaru roboczego agenta)

Ostrzeżenie: `scope: "shared"` wyłącza izolację między sesjami. Wszystkie sesje współdzielą
jeden kontener i jeden obszar roboczy.

### Profile sandboxa na agenta (wiele agentów)

Jeśli używasz routingu wielu agentów, każdy agent może nadpisać ustawienia sandboxa + narzędzi:
`agents.list[].sandbox` i `agents.list[].tools` (oraz `agents.list[].tools.sandbox.tools`). Pozwala to uruchamiać
mieszane poziomy dostępu w jednej bramie:

- Pełny dostęp (agent osobisty)
- Narzędzia tylko do odczytu + obszar roboczy tylko do odczytu (agent rodzinny/roboczy)
- Brak narzędzi systemu plików/powłoki (agent publiczny)

Zobacz [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) po przykłady,
priorytety i rozwiązywanie problemów.

### Zachowanie domyślne

- Obraz: `openclaw-sandbox:bookworm-slim`
- Jeden kontener na agenta
- Dostęp do obszaru roboczego agenta: `workspaceAccess: "none"` (domyślnie) używa `~/.openclaw/sandboxes`
  - `"ro"` utrzymuje obszar roboczy sandboxa w `/workspace` i montuje obszar roboczy agenta tylko do odczytu w `/agent` (wyłącza `write`/`edit`/`apply_patch`)
  - `"rw"` montuje obszar roboczy agenta do odczytu/zapisu w `/workspace`
- Auto-pruning: bezczynność > 24 h LUB wiek > 7 dni
- Sieć: `none` domyślnie (jawnie włącz, jeśli potrzebujesz wyjścia)
- Domyślnie dozwolone: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- Domyślnie zabronione: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Włącz sandboxing

Jeśli planujesz instalować pakiety w `setupCommand`, zwróć uwagę:

- Domyślne `docker.network` to `"none"` (brak wyjścia).
- `readOnlyRoot: true` blokuje instalację pakietów.
- `user` musi być rootem dla `apt-get` (pomiń `user` lub ustaw `user: "0:0"`).
  OpenClaw automatycznie odtwarza kontenery, gdy zmienia się `setupCommand` (lub konfiguracja Dockera),
  chyba że kontener był **niedawno używany** (w ciągu ~5 minut). Gorące kontenery
  logują ostrzeżenie z dokładnym poleceniem `openclaw sandbox recreate ...`.

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

Ustawienia utwardzania znajdują się pod `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

Wiele agentów: nadpisz `agents.defaults.sandbox.{docker,browser,prune}.*` na agenta przez `agents.list[].sandbox.{docker,browser,prune}.*`
(ignorowane, gdy `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` to `"shared"`).

### Zbuduj domyślny obraz sandboxa

```bash
scripts/sandbox-setup.sh
```

To buduje `openclaw-sandbox:bookworm-slim` przy użyciu `Dockerfile.sandbox`.

### Wspólny obraz sandboxa (opcjonalnie)

Jeśli chcesz obraz sandboxa z typowymi narzędziami do budowania (Node, Go, Rust itd.), zbuduj wspólny obraz:

```bash
scripts/sandbox-common-setup.sh
```

To buduje `openclaw-sandbox-common:bookworm-slim`. Aby go użyć:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Obraz przeglądarki sandboxa

Aby uruchomić narzędzie przeglądarki w sandboxie, zbuduj obraz przeglądarki:

```bash
scripts/sandbox-browser-setup.sh
```

To buduje `openclaw-sandbox-browser:bookworm-slim` przy użyciu
`Dockerfile.sandbox-browser`. Kontener uruchamia Chromium z włączonym CDP oraz
opcjonalnym obserwatorem noVNC (tryb graficzny przez Xvfb).

Uwagi:

- Tryb graficzny (Xvfb) zmniejsza blokowanie botów w porównaniu do headless.
- Headless nadal można użyć, ustawiając `agents.defaults.sandbox.browser.headless=true`.
- Pełne środowisko desktopowe (GNOME) nie jest wymagane; Xvfb zapewnia wyświetlacz.

Użyj konfiguracji:

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

Niestandardowy obraz przeglądarki:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

Po włączeniu agent otrzymuje:

- adres URL sterowania przeglądarką sandboxa (dla narzędzia `browser`)
- adres URL noVNC (jeśli włączone i headless=false)

Pamiętaj: jeśli używasz listy dozwolonych narzędzi, dodaj `browser` (i usuń z
deny), w przeciwnym razie narzędzie pozostanie zablokowane.
Zasady czyszczenia (`agents.defaults.sandbox.prune`) dotyczą także kontenerów przeglądarki.

### Niestandardowy obraz sandboxa

Zbuduj własny obraz i wskaż go w konfiguracji:

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

### Polityka narzędzi (allow/deny)

- `deny` ma pierwszeństwo nad `allow`.
- Jeśli `allow` jest puste: wszystkie narzędzia (poza deny) są dostępne.
- Jeśli `allow` nie jest puste: dostępne są tylko narzędzia z `allow` (minus deny).

### Strategia czyszczenia

Dwa parametry:

- `prune.idleHours`: usuń kontenery nieużywane przez X godzin (0 = wyłącz)
- `prune.maxAgeDays`: usuń kontenery starsze niż X dni (0 = wyłącz)

Przykład:

- Zachowaj aktywne sesje, ale ogranicz czas życia:
  `idleHours: 24`, `maxAgeDays: 7`
- Nigdy nie czyść:
  `idleHours: 0`, `maxAgeDays: 0`

### Uwagi dotyczące bezpieczeństwa

- Twarda izolacja dotyczy wyłącznie **narzędzi** (exec/read/write/edit/apply_patch).
- Narzędzia tylko-hostowe, takie jak browser/camera/canvas, są domyślnie zablokowane.
- Zezwolenie na `browser` w sandboxie **łamie izolację** (przeglądarka działa na hoście).

## Rozwiązywanie problemów

- Brak obrazu: zbuduj przy użyciu [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) lub ustaw `agents.defaults.sandbox.docker.image`.
- Kontener nie działa: zostanie automatycznie utworzony na żądanie dla sesji.
- Błędy uprawnień w sandboxie: ustaw `docker.user` na UID:GID odpowiadające
  własności zamontowanego obszaru roboczego (lub wykonaj chown na katalogu obszaru roboczego).
- Nie znaleziono narzędzi niestandardowych: OpenClaw uruchamia polecenia z `sh -lc` (powłoka logowania),
  która źródłuje `/etc/profile` i może resetować PATH. Ustaw `docker.env.PATH`, aby poprzedzić
  własne ścieżki narzędzi (np. `/custom/bin:/usr/local/share/npm-global/bin`), albo dodaj
  skrypt w `/etc/profile.d/` w swoim Dockerfile.
