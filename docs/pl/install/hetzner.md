---
summary: "Uruchom OpenClaw Gateway 24/7 na tanim VPS Hetzner (Docker) z trwałym stanem i wbudowanymi binariami"
read_when:
  - Chcesz uruchomić OpenClaw 24/7 na chmurowym VPS (nie na laptopie)
  - Chcesz produkcyjny, zawsze włączony Gateway na własnym VPS
  - Chcesz pełną kontrolę nad trwałością danych, binariami i zachowaniem przy restartach
  - Uruchamiasz OpenClaw w Dockerze na Hetznerze lub u podobnego dostawcy
title: "Hetzner"
x-i18n:
  source_path: install/hetzner.md
  source_hash: 84d9f24f1a803aa1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:28Z
---

# OpenClaw na Hetzner (Docker, przewodnik dla produkcyjnego VPS)

## Cel

Uruchomić trwały OpenClaw Gateway na VPS Hetzner z użyciem Dockera, z zachowaniem stanu, wbudowanymi binariami i bezpiecznym zachowaniem przy restartach.

Jeśli chcesz „OpenClaw 24/7 za ~5 USD”, jest to najprostsza niezawodna konfiguracja.
Cennik Hetznera się zmienia; wybierz najmniejszy VPS z Debianem/Ubuntu i zwiększ zasoby, jeśli napotkasz OOM.

## Co robimy (w prostych słowach)?

- Wynajmujemy mały serwer Linux (VPS Hetzner)
- Instalujemy Dockera (izolowane środowisko uruchomieniowe aplikacji)
- Uruchamiamy OpenClaw Gateway w Dockerze
- Utrwalamy `~/.openclaw` + `~/.openclaw/workspace` na hoście (przetrwa restarty/przebudowy)
- Uzyskujemy dostęp do interfejsu Control UI z laptopa przez tunel SSH

Dostęp do Gateway możliwy jest przez:

- Przekierowanie portów SSH z laptopa
- Bezpośrednie wystawienie portu, jeśli samodzielnie zarządzasz zaporą i tokenami

Ten przewodnik zakłada Ubuntu lub Debian na Hetznerze.  
Jeśli korzystasz z innego VPS Linux, dopasuj pakiety odpowiednio.
Dla ogólnego przepływu Dockera zobacz [Docker](/install/docker).

---

## Szybka ścieżka (doświadczeni operatorzy)

1. Utwórz VPS Hetzner
2. Zainstaluj Dockera
3. Sklonuj repozytorium OpenClaw
4. Utwórz trwałe katalogi na hoście
5. Skonfiguruj `.env` i `docker-compose.yml`
6. Wbuduj wymagane binaria do obrazu
7. `docker compose up -d`
8. Zweryfikuj trwałość i dostęp do Gateway

---

## Czego potrzebujesz

- VPS Hetzner z dostępem root
- Dostęp SSH z laptopa
- Podstawowa biegłość w SSH + kopiuj/wklej
- ~20 minut
- Docker i Docker Compose
- Poświadczenia uwierzytelniania modelu
- Opcjonalne poświadczenia dostawców
  - Kod QR WhatsApp
  - Token bota Telegram
  - OAuth Gmail

---

## 1) Utworzenie VPS

Utwórz VPS z Ubuntu lub Debianem w Hetznerze.

Połącz się jako root:

```bash
ssh root@YOUR_VPS_IP
```

Ten przewodnik zakłada, że VPS jest stanowy.
Nie traktuj go jako infrastruktury jednorazowej.

---

## 2) Instalacja Dockera (na VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Weryfikacja:

```bash
docker --version
docker compose version
```

---

## 3) Klonowanie repozytorium OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Ten przewodnik zakłada, że zbudujesz własny obraz, aby zagwarantować trwałość binariów.

---

## 4) Utworzenie trwałych katalogów na hoście

Kontenery Dockera są efemeryczne.
Cały długotrwały stan musi znajdować się na hoście.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) Konfiguracja zmiennych środowiskowych

Utwórz `.env` w katalogu głównym repozytorium.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Wygeneruj silne sekrety:

```bash
openssl rand -hex 32
```

**Nie commituj tego pliku.**

---

## 6) Konfiguracja Docker Compose

Utwórz lub zaktualizuj `docker-compose.yml`.

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
      ]
```

---

## 7) Wbudowanie wymaganych binariów do obrazu (krytyczne)

Instalowanie binariów wewnątrz działającego kontenera to pułapka.
Wszystko zainstalowane w czasie działania zostanie utracone po restarcie.

Wszystkie zewnętrzne binaria wymagane przez Skills muszą być instalowane na etapie budowania obrazu.

Poniższe przykłady pokazują tylko trzy typowe binaria:

- `gog` do dostępu do Gmaila
- `goplaces` do Google Places
- `wacli` do WhatsApp

To są przykłady, nie pełna lista.
Możesz zainstalować dowolną liczbę binariów, używając tego samego wzorca.

Jeśli później dodasz nowe Skills zależne od dodatkowych binariów, musisz:

1. Zaktualizować Dockerfile
2. Przebudować obraz
3. Zrestartować kontenery

**Przykładowy Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 8) Budowanie i uruchomienie

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Weryfikacja binariów:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Oczekiwane wyjście:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9) Weryfikacja Gateway

```bash
docker compose logs -f openclaw-gateway
```

Sukces:

```
[gateway] listening on ws://0.0.0.0:18789
```

Z laptopa:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Otwórz:

`http://127.0.0.1:18789/`

Wklej token Gateway.

---

## Co i gdzie jest utrwalane (źródło prawdy)

OpenClaw działa w Dockerze, ale Docker nie jest źródłem prawdy.
Cały długotrwały stan musi przetrwać restarty, przebudowy i rebooty.

| Komponent                       | Lokalizacja                       | Mechanizm trwałości   | Uwagi                                |
| ------------------------------- | --------------------------------- | --------------------- | ------------------------------------ |
| Konfiguracja Gateway            | `/home/node/.openclaw/`           | Montaż wolumenu hosta | Zawiera `openclaw.json`, tokeny      |
| Profile uwierzytelniania modeli | `/home/node/.openclaw/`           | Montaż wolumenu hosta | Tokeny OAuth, klucze API             |
| Konfiguracje Skills             | `/home/node/.openclaw/skills/`    | Montaż wolumenu hosta | Stan na poziomie Skills              |
| Obszar roboczy agenta           | `/home/node/.openclaw/workspace/` | Montaż wolumenu hosta | Kod i artefakty agenta               |
| Sesja WhatsApp                  | `/home/node/.openclaw/`           | Montaż wolumenu hosta | Zachowuje logowanie QR               |
| Pęk kluczy Gmail                | `/home/node/.openclaw/`           | Wolumen hosta + hasło | Wymaga `GOG_KEYRING_PASSWORD`        |
| Zewnętrzne binaria              | `/usr/local/bin/`                 | Obraz Dockera         | Muszą być wbudowane na etapie builda |
| Środowisko Node                 | System plików kontenera           | Obraz Dockera         | Odbudowywane przy każdym buildzie    |
| Pakiety systemowe               | System plików kontenera           | Obraz Dockera         | Nie instalować w czasie działania    |
| Kontener Dockera                | Efemeryczny                       | Restartowalny         | Bezpieczny do zniszczenia            |
