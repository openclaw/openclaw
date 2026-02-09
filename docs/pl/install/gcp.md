---
summary: "Uruchom OpenClaw Gateway 24/7 na maszynie wirtualnej GCP Compute Engine (Docker) z trwałym stanem"
read_when:
  - Chcesz, aby OpenClaw działał 24/7 na GCP
  - Chcesz produkcyjny, zawsze włączony Gateway na własnej maszynie wirtualnej
  - Chcesz pełnej kontroli nad trwałością danych, binariami i zachowaniem przy restartach
title: "GCP"
---

# OpenClaw na GCP Compute Engine (Docker, przewodnik produkcyjny VPS)

## Cel

Uruchom trwały OpenClaw Gateway na maszynie wirtualnej GCP Compute Engine z użyciem Dockera, z zachowaniem stanu, wbudowanymi binariami i bezpiecznym zachowaniem przy restartach.

Jeśli chcesz „OpenClaw 24/7 za ~5–12 USD/mies.”, jest to niezawodna konfiguracja na Google Cloud.
Cena zależy od typu maszyny i regionu; wybierz najmniejszą maszynę wirtualną, która pasuje do Twojego obciążenia, i zwiększ ją, jeśli napotkasz błędy OOM.

## Co robimy (w prostych słowach)?

- Tworzymy projekt GCP i włączamy rozliczenia
- Tworzymy maszynę wirtualną Compute Engine
- Instalujemy Dockera (izolowane środowisko uruchomieniowe aplikacji)
- Uruchamiamy OpenClaw Gateway w Dockerze
- Utrwalamy `~/.openclaw` + `~/.openclaw/workspace` na hoście (przetrwa restarty/przebudowy)
- Uzyskujemy dostęp do interfejsu sterowania z laptopa przez tunel SSH

Dostęp do Gateway jest możliwy przez:

- Przekierowanie portów SSH z laptopa
- Bezpośrednie wystawienie portu, jeśli samodzielnie zarządzasz zaporą i tokenami

Ten przewodnik używa Debiana na GCP Compute Engine.
Ubuntu również działa; należy odpowiednio dopasować pakiety.
Ogólny przepływ Dockera opisano w [Docker](/install/docker).

---

## Szybka ścieżka (doświadczeni operatorzy)

1. Utwórz projekt GCP + włącz API Compute Engine
2. Utwórz maszynę wirtualną Compute Engine (e2-small, Debian 12, 20 GB)
3. Połącz się z maszyną przez SSH
4. Zainstaluj Dockera
5. Sklonuj repozytorium OpenClaw
6. Utwórz trwałe katalogi na hoście
7. Skonfiguruj `.env` i `docker-compose.yml`
8. Wbuduj wymagane binaria, zbuduj obraz i uruchom

---

## Czego potrzebujesz

- Konto GCP (warstwa darmowa obejmuje e2-micro)
- Zainstalowane CLI gcloud (lub użycie Cloud Console)
- Dostęp SSH z laptopa
- Podstawowa znajomość SSH + kopiowania/wklejania
- ~20–30 minut
- Docker i Docker Compose
- Poświadczenia uwierzytelniania modelu
- Opcjonalne poświadczenia dostawców
  - Kod QR WhatsApp
  - Token bota Telegram
  - OAuth Gmail

---

## 1. Instalacja gcloud CLI (lub użycie konsoli)

**Opcja A: gcloud CLI** (zalecane do automatyzacji)

Zainstaluj z: [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Zainicjalizuj i uwierzytelnij:

```bash
gcloud init
gcloud auth login
```

**Opcja B: Cloud Console**

Wszystkie kroki można wykonać przez interfejs WWW na stronie [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. Utworzenie projektu GCP

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Włącz rozliczenia na stronie [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (wymagane dla Compute Engine).

Włącz API Compute Engine:

```bash
gcloud services enable compute.googleapis.com
```

**Konsola:**

1. Przejdź do IAM i Administracja > Utwórz projekt
2. Nadaj nazwę i utwórz
3. Włącz rozliczenia dla projektu
4. Przejdź do API i usługi > Włącz API > wyszukaj „Compute Engine API” > Włącz

---

## 3. Utworzenie maszyny wirtualnej

**Typy maszyn:**

| Typ      | Specyfikacja                                        | Koszt                           | Uwagi                              |
| -------- | --------------------------------------------------- | ------------------------------- | ---------------------------------- |
| e2-small | 2 vCPU, 2 GB RAM                                    | ~12 $ / miesiąc | Zalecane                           |
| e2-micro | 2 vCPU (współdzielone), 1 GB RAM | Warstwa darmowa                 | Może powodować OOM przy obciążeniu |

**CLI:**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Konsola:**

1. Przejdź do Compute Engine > Instancje VM > Utwórz instancję
2. Nazwa: `openclaw-gateway`
3. Region: `us-central1`, Strefa: `us-central1-a`
4. Typ maszyny: `e2-small`
5. Dysk startowy: Debian 12, 20 GB
6. Utwórz

---

## 4. Połączenie SSH z maszyną wirtualną

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Konsola:**

Kliknij przycisk „SSH” obok swojej maszyny wirtualnej w panelu Compute Engine.

Uwaga: propagacja klucza SSH może zająć 1–2 minuty po utworzeniu maszyny. Jeśli połączenie jest odrzucane, odczekaj i spróbuj ponownie.

---

## 5. Instalacja Dockera (na maszynie wirtualnej)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Wyloguj się i zaloguj ponownie, aby zmiana grupy zaczęła obowiązywać:

```bash
exit
```

Następnie połącz się ponownie przez SSH:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Weryfikacja:

```bash
docker --version
docker compose version
```

---

## 6. Sklonowanie repozytorium OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Ten przewodnik zakłada, że zbudujesz niestandardowy obraz, aby zagwarantować trwałość binariów.

---

## 7. Utworzenie trwałych katalogów na hoście

Kontenery Dockera są efemeryczne.
Cały długotrwały stan musi znajdować się na hoście.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Konfiguracja zmiennych środowiskowych

Utwórz `.env` w katalogu głównym repozytorium.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Wygeneruj silne sekrety:

```bash
openssl rand -hex 32
```

**Nie commituj tego pliku.**

---

## 9. Konfiguracja Docker Compose

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
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
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

## 10. Wbudowanie wymaganych binariów w obraz (krytyczne)

Instalowanie binariów wewnątrz działającego kontenera to pułapka.
Wszystko, co zostanie zainstalowane w czasie działania, zostanie utracone przy restarcie.

Wszystkie zewnętrzne binaria wymagane przez Skills muszą być instalowane na etapie budowania obrazu.

Poniższe przykłady pokazują tylko trzy często spotykane binaria:

- `gog` do dostępu do Gmaila
- `goplaces` do Google Places
- `wacli` do WhatsApp

Są to przykłady, a nie kompletna lista.
Możesz zainstalować dowolną liczbę binariów, stosując ten sam wzorzec.

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

## 11. Budowanie i uruchamianie

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

## 12. Weryfikacja Gateway

```bash
docker compose logs -f openclaw-gateway
```

Sukces:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Dostęp z laptopa

Utwórz tunel SSH, aby przekierować port Gateway:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Otwórz w przeglądarce:

`http://127.0.0.1:18789/`

Wklej token Gateway.

---

## Co gdzie się utrwala (źródło prawdy)

OpenClaw działa w Dockerze, ale Docker nie jest źródłem prawdy.
Cały długotrwały stan musi przetrwać restarty, przebudowy i ponowne uruchomienia systemu.

| Komponent             | Lokalizacja                       | Mechanizm trwałości       | Uwagi                               |
| --------------------- | --------------------------------- | ------------------------- | ----------------------------------- |
| Konfiguracja Gateway  | `/home/node/.openclaw/`           | Montowanie woluminu hosta | Zawiera `openclaw.json`, tokeny     |
| Profile auth modeli   | `/home/node/.openclaw/`           | Montowanie woluminu hosta | Tokeny OAuth, klucze API            |
| Konfiguracje Skills   | `/home/node/.openclaw/skills/`    | Montowanie woluminu hosta | Stan na poziomie Skill              |
| Obszar roboczy agenta | `/home/node/.openclaw/workspace/` | Montowanie woluminu hosta | Kod i artefakty agenta              |
| Sesja WhatsApp        | `/home/node/.openclaw/`           | Montowanie woluminu hosta | Zachowuje logowanie QR              |
| Pęk kluczy Gmail      | `/home/node/.openclaw/`           | Wolumin hosta + hasło     | Wymaga `GOG_KEYRING_PASSWORD`       |
| Zewnętrzne binaria    | `/usr/local/bin/`                 | Obraz Dockera             | Musi być upieczony w czasie budowy  |
| Runtime Node          | System plików kontenera           | Obraz Dockera             | Przebudowywany przy każdym buildzie |
| Pakiety systemowe     | System plików kontenera           | Obraz Dockera             | Nie instalować w czasie działania   |
| Kontener Dockera      | Efemeryczny                       | Możliwy do restartu       | Bezpieczny do usunięcia             |

---

## Aktualizacje

Aby zaktualizować OpenClaw na maszynie wirtualnej:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Rozwiązywanie problemów

**Odrzucone połączenie SSH**

Propagacja klucza SSH może zająć 1–2 minuty po utworzeniu maszyny. Odczekaj i spróbuj ponownie.

**Problemy z OS Login**

Sprawdź swój profil OS Login:

```bash
gcloud compute os-login describe-profile
```

Upewnij się, że Twoje konto ma wymagane uprawnienia IAM (Compute OS Login lub Compute OS Admin Login).

**Brak pamięci (OOM)**

Jeśli używasz e2-micro i napotykasz OOM, przejdź na e2-small lub e2-medium:

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Konta usługi (najlepsze praktyki bezpieczeństwa)

Do użytku osobistego domyślne konto użytkownika w zupełności wystarcza.

Do automatyzacji lub potoków CI/CD utwórz dedykowane konto usługi z minimalnymi uprawnieniami:

1. Utwórz konto usługi:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Nadaj rolę Compute Instance Admin (lub węższą, niestandardową rolę):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Unikaj używania roli Owner do automatyzacji. Stosuj zasadę najmniejszych uprawnień.

Szczegóły ról IAM znajdziesz na stronie [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles).

---

## Następne kroki

- Skonfiguruj kanały komunikacji: [Channels](/channels)
- Sparuj lokalne urządzenia jako węzły: [Nodes](/nodes)
- Skonfiguruj Gateway: [Gateway configuration](/gateway/configuration)
