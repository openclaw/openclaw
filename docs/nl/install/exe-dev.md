---
summary: "OpenClaw Gateway uitvoeren op exe.dev (VM + HTTPS-proxy) voor externe toegang"
read_when:
  - Je wilt een goedkope, altijd ingeschakelde Linux-host voor de Gateway
  - Je wilt externe toegang tot de Control UI zonder je eigen VPS te draaien
title: "exe.dev"
---

# exe.dev

Doel: OpenClaw Gateway draaiend op een exe.dev-VM, bereikbaar vanaf je laptop via: `https://<vm-name>.exe.xyz`

Deze pagina gaat uit van exe.dev’s standaard **exeuntu**-image. Als je een andere distro hebt gekozen, pas de pakketten dienovereenkomstig aan.

## Snelle route voor beginners

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Vul je auth-sleutel/token in waar nodig
3. Klik op "Agent" naast je VM en wacht…
4. ???
5. Profit

## Wat je nodig hebt

- exe.dev-account
- `ssh exe.dev` toegang tot [exe.dev](https://exe.dev) virtuele machines (optioneel)

## Geautomatiseerde installatie met Shelley

Shelley, de agent van [exe.dev](https://exe.dev), kan OpenClaw direct installeren met onze
prompt. De gebruikte prompt is als volgt:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Handmatige installatie

## 1. De VM aanmaken

Vanaf je apparaat:

```bash
ssh exe.dev new
```

Verbind vervolgens:

```bash
ssh <vm-name>.exe.xyz
```

Tip: houd deze VM **stateful**. OpenClaw slaat status op onder `~/.openclaw/` en `~/.openclaw/workspace/`.

## 2. Vereisten installeren (op de VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. OpenClaw installeren

Voer het OpenClaw-installatiescript uit:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. nginx instellen om OpenClaw te proxien naar poort 8000

Bewerk `/etc/nginx/sites-enabled/default` met

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

## 5. OpenClaw openen en rechten verlenen

Open `https://<vm-name>.exe.xyz/` (zie de Control UI-uitvoer van onboarding). Als er om authenticatie wordt gevraagd, plak
de token uit `gateway.auth.token` op de VM (ophalen met `openclaw config get gateway.auth.token`, of een nieuwe genereren
met `openclaw doctor --generate-gateway-token`). Keur apparaten goed met `openclaw devices list` en
`openclaw devices approve <requestId>`. Gebruik bij twijfel Shelley vanuit je browser!

## Externe toegang

Externe toegang wordt afgehandeld door de authenticatie van [exe.dev](https://exe.dev). Standaard
wordt HTTP-verkeer van poort 8000 doorgestuurd naar `https://<vm-name>.exe.xyz`
met e-mailauthenticatie.

## Bijwerken

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Handleiding: [Updating](/install/updating)
