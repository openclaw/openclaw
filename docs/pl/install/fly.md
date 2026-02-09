---
title: Fly.io
description: Deploy OpenClaw on Fly.io
---

# Wdrożenie na Fly.io

**Cel:** Gateway OpenClaw uruchomiony na maszynie [Fly.io](https://fly.io) z trwałym magazynem danych, automatycznym HTTPS oraz dostępem do Discorda/kanałów.

## Czego potrzebujesz

- Zainstalowane [CLI flyctl](https://fly.io/docs/hands-on/install-flyctl/)
- Konto Fly.io (wystarczy plan darmowy)
- Uwierzytelnienie modelu: klucz API Anthropic (lub inne klucze dostawców)
- Dane kanałów: token bota Discord, token Telegram itp.

## Szybka ścieżka dla początkujących

1. Sklonuj repozytorium → dostosuj `fly.toml`
2. Utwórz aplikację + wolumen → ustaw sekrety
3. Wdróż za pomocą `fly deploy`
4. Zaloguj się przez SSH, aby utworzyć konfigurację, lub użyj Control UI

## 1) Utwórz aplikację Fly

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Wskazówka:** Wybierz region blisko siebie. Popularne opcje: `lhr` (Londyn), `iad` (Wirginia), `sjc` (San Jose).

## 2. Skonfiguruj fly.toml

Edytuj `fly.toml`, aby dopasować do nazwy aplikacji i wymagań.

**Uwaga dotycząca bezpieczeństwa:** Domyślna konfiguracja wystawia publiczny URL. Dla wzmocnionego wdrożenia bez publicznego IP zobacz [Prywatne wdrożenie](#private-deployment-hardened) lub użyj `fly.private.toml`.

```toml
app = "my-openclaw"  # Your app name
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**Kluczowe ustawienia:**

| Ustawienie                     | Dlaczego                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Wiąże z `0.0.0.0`, aby proxy Fly mogło dotrzeć do gateway                                               |
| `--allow-unconfigured`         | Uruchamia bez pliku konfiguracyjnego (utworzysz go później)                          |
| `internal_port = 3000`         | Musi odpowiadać `--port 3000` (lub `OPENCLAW_GATEWAY_PORT`) dla kontroli zdrowia Fly |
| `memory = "2048mb"`            | 512 MB to za mało; zalecane 2 GB                                                                        |
| `OPENCLAW_STATE_DIR = "/data"` | Utrwala stan na wolumenie                                                                               |

## 3. Ustaw sekrety

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**Uwagi:**

- Powiązania nie-loopback (`--bind lan`) wymagają `OPENCLAW_GATEWAY_TOKEN` ze względów bezpieczeństwa.
- Traktuj te tokeny jak hasła.
- **Preferuj zmienne środowiskowe zamiast pliku konfiguracyjnego** dla wszystkich kluczy API i tokenów. Dzięki temu sekrety nie trafią do `openclaw.json`, gdzie mogłyby zostać przypadkowo ujawnione lub zalogowane.

## 4. Wdrożenie

```bash
fly deploy
```

Pierwsze wdrożenie buduje obraz Dockera (~2–3 minuty). Kolejne wdrożenia są szybsze.

Po wdrożeniu sprawdź:

```bash
fly status
fly logs
```

Powinieneś zobaczyć:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Utwórz plik konfiguracyjny

Zaloguj się przez SSH do maszyny, aby utworzyć właściwą konfigurację:

```bash
fly ssh console
```

Utwórz katalog konfiguracji i plik:

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**Uwaga:** Przy `OPENCLAW_STATE_DIR=/data` ścieżka konfiguracji to `/data/openclaw.json`.

**Uwaga:** Token Discorda może pochodzić z:

- Zmiennej środowiskowej: `DISCORD_BOT_TOKEN` (zalecane dla sekretów)
- Pliku konfiguracyjnego: `channels.discord.token`

Jeśli używasz zmiennej środowiskowej, nie trzeba dodawać tokenu do konfiguracji. Gateway automatycznie odczytuje `DISCORD_BOT_TOKEN`.

Uruchom ponownie, aby zastosować:

```bash
exit
fly machine restart <machine-id>
```

## 6. Dostęp do Gateway

### Control UI

Otwórz w przeglądarce:

```bash
fly open
```

Lub odwiedź `https://my-openclaw.fly.dev/`

Wklej token gateway (ten z `OPENCLAW_GATEWAY_TOKEN`), aby się uwierzytelnić.

### Logi

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### Konsola SSH

```bash
fly ssh console
```

## Rozwiązywanie problemów

### „App is not listening on expected address”

Gateway wiąże się z `127.0.0.1` zamiast `0.0.0.0`.

**Naprawa:** Dodaj `--bind lan` do polecenia procesu w `fly.toml`.

### Niesprawne kontrole zdrowia / connection refused

Fly nie może dotrzeć do gateway na skonfigurowanym porcie.

**Naprawa:** Upewnij się, że `internal_port` odpowiada portowi gateway (ustaw `--port 3000` lub `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / problemy z pamięcią

Kontener ciągle się restartuje lub jest zabijany. Oznaki: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration` lub ciche restarty.

**Naprawa:** Zwiększ pamięć w `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

Lub zaktualizuj istniejącą maszynę:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Uwaga:** 512 MB jest zbyt małe. **Uwaga:** 512 MB to za mało. 1 GB może działać, ale może powodować OOM pod obciążeniem lub przy gadatliwym logowaniu. **Zalecane są 2 GB.**

### Problemy z blokadą Gateway

Gateway odmawia startu z błędami „already running”.

Dzieje się tak, gdy kontener restartuje się, ale plik blokady PID pozostaje na wolumenie.

**Naprawa:** Usuń plik blokady:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Plik blokady znajduje się w `/data/gateway.*.lock` (nie w podkatalogu).

### Konfiguracja nie jest odczytywana

Jeśli używasz `--allow-unconfigured`, gateway tworzy minimalną konfigurację. Twoja niestandardowa konfiguracja w `/data/openclaw.json` powinna zostać odczytana po restarcie.

Sprawdź, czy konfiguracja istnieje:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Zapisywanie konfiguracji przez SSH

Polecenie `fly ssh console -C` nie obsługuje przekierowania powłoki. Aby zapisać plik konfiguracyjny:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Uwaga:** `fly sftp` może się nie powieść, jeśli plik już istnieje. Najpierw usuń:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### Stan nie jest utrwalany

Jeśli po restarcie tracisz poświadczenia lub sesje, katalog stanu zapisuje się do systemu plików kontenera.

**Naprawa:** Upewnij się, że `OPENCLAW_STATE_DIR=/data` jest ustawione w `fly.toml` i wykonaj ponowne wdrożenie.

## Aktualizacje

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Aktualizacja polecenia maszyny

Jeśli musisz zmienić polecenie startowe bez pełnego ponownego wdrożenia:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Uwaga:** Po `fly deploy` polecenie maszyny może zostać zresetowane do tego z `fly.toml`. Jeśli wprowadzałeś zmiany ręcznie, zastosuj je ponownie po wdrożeniu.

## Prywatne wdrożenie (wzmocnione)

Domyślnie Fly przydziela publiczne adresy IP, co sprawia, że gateway jest dostępny pod `https://your-app.fly.dev`. To wygodne, ale oznacza, że wdrożenie jest wykrywalne przez skanery internetu (Shodan, Censys itp.).

Dla wzmocnionego wdrożenia **bez publicznej ekspozycji** użyj prywatnego szablonu.

### Kiedy używać prywatnego wdrożenia

- Wykonujesz tylko połączenia/wiadomości **wychodzące** (bez webhooków przychodzących)
- Używasz tuneli **ngrok lub Tailscale** dla wszelkich callbacków webhooków
- Uzyskujesz dostęp do gateway przez **SSH, proxy lub WireGuard**, a nie przez przeglądarkę
- Chcesz, aby wdrożenie było **ukryte przed skanerami internetu**

### Konfiguracja

Użyj `fly.private.toml` zamiast standardowej konfiguracji:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Albo skonwertuj istniejące wdrożenie:

```bash
# List current IPs
fly ips list -a my-openclaw

# Release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with the private template)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

Po tym `fly ips list` powinno pokazywać tylko adres IP typu `private`:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Dostęp do prywatnego wdrożenia

Ponieważ nie ma publicznego URL, użyj jednej z metod:

**Opcja 1: Lokalny proxy (najprostsze)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Opcja 2: VPN WireGuard**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Opcja 3: Tylko SSH**

```bash
fly ssh console -a my-openclaw
```

### Webhooki z prywatnym wdrożeniem

Jeśli potrzebujesz callbacków webhooków (Twilio, Telnyx itp.) bez publicznej ekspozycji:

1. **Tunel ngrok** – uruchom ngrok wewnątrz kontenera lub jako sidecar
2. **Tailscale Funnel** – wystawiaj konkretne ścieżki przez Tailscale
3. **Tylko ruch wychodzący** – niektórzy dostawcy (Twilio) działają poprawnie dla połączeń wychodzących bez webhooków

Przykładowa konfiguracja połączeń głosowych z ngrok:

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" },
          "webhookSecurity": {
            "allowedHosts": ["example.ngrok.app"]
          }
        }
      }
    }
  }
}
```

Tunel ngrok działa wewnątrz kontenera i zapewnia publiczny URL webhooka bez wystawiania samej aplikacji Fly. Ustaw `webhookSecurity.allowedHosts` na publiczną nazwę hosta tunelu, aby akceptować przekazywane nagłówki hosta.

### Korzyści bezpieczeństwa

| Aspekt                 | Publiczne    | Prywatne    |
| ---------------------- | ------------ | ----------- |
| Skanery internetu      | Wykrywalne   | Hidden      |
| Ataki bezpośrednie     | Możliwe      | Zablokowane |
| Dostęp do Control UI   | Przeglądarka | Proxy/VPN   |
| Dostarczanie webhooków | Bezpośrednie | Przez tunel |

## Uwagi

- Fly.io używa **architektury x86** (nie ARM)
- Dockerfile jest zgodny z obiema architekturami
- Do onboardingu WhatsApp/Telegram użyj `fly ssh console`
- Trwałe dane znajdują się na wolumenie w `/data`
- Signal wymaga Java + signal-cli; użyj niestandardowego obrazu i utrzymuj pamięć na poziomie 2 GB+.

## Koszt

Przy zalecanej konfiguracji (`shared-cpu-2x`, 2 GB RAM):

- ~10–15 USD/miesiąc w zależności od użycia
- Plan darmowy obejmuje pewien limit

Szczegóły znajdziesz w [cenniku Fly.io](https://fly.io/docs/about/pricing/).
