---
summary: "Uruchom OpenClaw Gateway na exe.dev (VM + proxy HTTPS) w celu zdalnego dostępu"
read_when:
  - Chcesz tani, zawsze włączony host Linux dla Gateway
  - Chcesz zdalny dostęp do Control UI bez uruchamiania własnego VPS
title: "exe.dev"
---

# exe.dev

Cel: OpenClaw Gateway uruchomiony na maszynie wirtualnej exe.dev, osiągalny z laptopa przez: `https://<vm-name>.exe.xyz`

Ta strona zakłada domyślny obraz **exeuntu** w exe.dev. Jeśli wybrałeś inną dystrybucję, dopasuj pakiety odpowiednio.

## Szybka ścieżka dla początkujących

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Wypełnij klucz/token uwierzytelniający zgodnie z potrzebą
3. Kliknij „Agent” obok swojej VM i poczekaj...
4. ???
5. Zysk

## Czego potrzebujesz

- konto exe.dev
- dostęp `ssh exe.dev` do maszyn wirtualnych [exe.dev](https://exe.dev) (opcjonalne)

## Zautomatyzowana instalacja z Shelley

Shelley, agent [exe.dev](https://exe.dev), może natychmiast zainstalować OpenClaw przy użyciu naszego
promptu. Użyty prompt jest następujący:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Instalacja ręczna

## 1. Utwórz VM

Z Twojego urządzenia:

```bash
ssh exe.dev new
```

Następnie połącz się:

```bash
ssh <vm-name>.exe.xyz
```

Wskazówka: utrzymuj tę VM jako **stanową**. OpenClaw przechowuje stan w `~/.openclaw/` oraz `~/.openclaw/workspace/`.

## 2. Zainstaluj wymagania wstępne (na VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. Zainstaluj OpenClaw

Uruchom skrypt instalacyjny OpenClaw:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. Skonfiguruj nginx, aby proxy’ować OpenClaw na port 8000

Edytuj `/etc/nginx/sites-enabled/default` z

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5. Uzyskaj dostęp do OpenClaw i nadaj uprawnienia

Otwórz `https://<vm-name>.exe.xyz/` (zobacz wyjście Control UI z onboardingu). Jeśli pojawi się prośba o uwierzytelnienie, wklej
token z `gateway.auth.token` na VM (pobierz go za pomocą `openclaw config get gateway.auth.token` lub wygeneruj
przy użyciu `openclaw doctor --generate-gateway-token`). Zatwierdź urządzenia za pomocą `openclaw devices list` oraz
`openclaw devices approve <requestId>`. W razie wątpliwości użyj Shelley z przeglądarki!

## Zdalny dostęp

Zdalny dostęp jest obsługiwany przez uwierzytelnianie [exe.dev](https://exe.dev). Domyślnie
ruch HTTP z portu 8000 jest przekazywany do `https://<vm-name>.exe.xyz`
z uwierzytelnianiem e-mail.

## Aktualizowanie

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Przewodnik: [Updating](/install/updating)
