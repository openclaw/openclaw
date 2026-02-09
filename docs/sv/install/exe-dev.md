---
summary: "Kör OpenClaw Gateway på exe.dev (VM + HTTPS-proxy) för fjärråtkomst"
read_when:
  - Du vill ha en billig Linux-värd som alltid är igång för Gateway
  - Du vill ha fjärråtkomst till Control UI utan att köra din egen VPS
title: "exe.dev"
---

# exe.dev

Mål: OpenClaw Gateway körs på en exe.dev-VM och kan nås från din laptop via: `https://<vm-name>.exe.xyz`

Denna sida antar exe.devs standard **exeuntu** bild. Om du valde en annan distro, kartpaket därefter.

## Snabb väg för nybörjare

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Fyll i din auth-nyckel/token vid behov
3. Klicka på ”Agent” bredvid din VM och vänta…
4. ???
5. Profit

## Vad du behöver

- exe.dev-konto
- `ssh exe.dev` åtkomst till virtuella maskiner på [exe.dev](https://exe.dev) (valfritt)

## Automatiserad installation med Shelley

Shelley, [exe.dev](https://exe.dev)'s agent, kan installera OpenClaw direkt med vår
prompt. Den fråga som används är som nedan:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Manuell installation

## 1. Skapa VM:n

Från din enhet:

```bash
ssh exe.dev new
```

Anslut sedan:

```bash
ssh <vm-name>.exe.xyz
```

Tips: behåll denna VM **stateful**. OpenClaw lagrar tillstånd under `~/.openclaw/` och `~/.openclaw/workspace/`.

## 2. Installera förutsättningar (på VM:n)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. Installera OpenClaw

Kör OpenClaws installationsskript:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. Konfigurera nginx för att proxy OpenClaw till port 8000

Redigera `/etc/nginx/sites-enabled/default` med

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

## 5. Få åtkomst till OpenClaw och bevilja behörigheter

Åtkomst till `https://<vm-name>.exe.xyz/` (se Control UI-utdata från onboarding). Om den uppmanar till auth, klistra in
-token från `gateway.auth.token` på VM (hämta med `openclaw config get gateway. uth.token`, eller generera ett
med `openclaw doctor --generate-gateway-token`). Godkänn enheter med `openclaw enheter list` och
`openclaw enheter godkänner <requestId>`. När du är osäker, använd Shelley från din webbläsare!

## Fjärråtkomst

Fjärråtkomst hanteras av [exe.dev](https://exe.dev)'s autentisering. Som
standard vidarebefordras HTTP-trafiken från port 8000 till `https://<vm-name>.exe.xyz`
med e-postförfattare.

## Uppdatering

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Guide: [Updating](/install/updating)
