---
summary: "Kør OpenClaw Gateway på exe.dev (VM + HTTPS-proxy) for fjernadgang"
read_when:
  - Du vil have en billig Linux-vært, der altid er tændt, til Gateway
  - Du vil have fjernadgang til Control UI uden at køre din egen VPS
title: "exe.dev"
x-i18n:
  source_path: install/exe-dev.md
  source_hash: 72ab798afd058a76
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:21Z
---

# exe.dev

Mål: OpenClaw Gateway kørende på en exe.dev VM, tilgængelig fra din laptop via: `https://<vm-name>.exe.xyz`

Denne side antager exe.dev’s standard **exeuntu**-image. Hvis du har valgt en anden distro, skal pakkerne mappes tilsvarende.

## Hurtig vej for begyndere

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Udfyld din auth-nøgle/token efter behov
3. Klik på "Agent" ved siden af din VM, og vent...
4. ???
5. Profit

## Hvad du skal bruge

- exe.dev-konto
- `ssh exe.dev` adgang til [exe.dev](https://exe.dev) virtuelle maskiner (valgfrit)

## Automatiseret installation med Shelley

Shelley, [exe.dev](https://exe.dev)s agent, kan installere OpenClaw øjeblikkeligt med vores
prompt. Den anvendte prompt er som følger:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Manuel installation

## 1) Opret VM’en

Fra din enhed:

```bash
ssh exe.dev new
```

Forbind derefter:

```bash
ssh <vm-name>.exe.xyz
```

Tip: Hold denne VM **stateful**. OpenClaw gemmer tilstand under `~/.openclaw/` og `~/.openclaw/workspace/`.

## 2) Installér forudsætninger (på VM’en)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) Installér OpenClaw

Kør OpenClaw-installationsscriptet:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) Opsæt nginx til at proxy OpenClaw til port 8000

Redigér `/etc/nginx/sites-enabled/default` med

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

## 5) Tilgå OpenClaw og tildel rettigheder

Tilgå `https://<vm-name>.exe.xyz/` (se Control UI-outputtet fra introduktionen). Hvis den beder om autentificering, indsæt
tokenet fra `gateway.auth.token` på VM’en (hent det med `openclaw config get gateway.auth.token`, eller generér et
med `openclaw doctor --generate-gateway-token`). Godkend enheder med `openclaw devices list` og
`openclaw devices approve <requestId>`. Når du er i tvivl, så brug Shelley fra din browser!

## Fjernadgang

Fjernadgang håndteres af [exe.dev](https://exe.dev)s autentificering. Som
standard videresendes HTTP-trafik fra port 8000 til `https://<vm-name>.exe.xyz`
med e-mail-autentificering.

## Opdatering

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Guide: [Opdatering](/install/updating)
