---
summary: "Patakbuhin ang OpenClaw Gateway sa exe.dev (VM + HTTPS proxy) para sa remote access"
read_when:
  - Gusto mo ng murang laging-on na Linux host para sa Gateway
  - Gusto mo ng remote Control UI access nang hindi nagpapatakbo ng sarili mong VPS
title: "exe.dev"
---

# exe.dev

Layunin: OpenClaw Gateway na tumatakbo sa isang exe.dev VM, naaabot mula sa iyong laptop sa pamamagitan ng: `https://<vm-name>.exe.xyz`

Ipinapalagay ng pahinang ito ang default na **exeuntu** image ng exe.dev. Kung pumili ka ng ibang distro, i-map ang mga package nang naaayon.

## Mabilis na ruta para sa baguhan

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Ilagay ang iyong auth key/token kung kinakailangan
3. I-click ang "Agent" sa tabi ng iyong VM, at maghintay...
4. ???
5. Tubo

## Ano ang kailangan mo

- exe.dev account
- `ssh exe.dev` access sa mga virtual machine ng [exe.dev](https://exe.dev) (opsyonal)

## Automated Install gamit ang Shelley

Si Shelley, ang agent ng [exe.dev](https://exe.dev), ay maaaring mag-install ng OpenClaw kaagad gamit ang aming
prompt. Ang prompt na ginamit ay nasa ibaba:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Manual na pag-install

## 1. Gumawa ng VM

Mula sa iyong device:

```bash
ssh exe.dev new
```

Pagkatapos ay kumonek:

```bash
ssh <vm-name>.exe.xyz
```

Tip: panatilihing **stateful** ang VM na ito. Iniimbak ng OpenClaw ang state sa ilalim ng `~/.openclaw/` at `~/.openclaw/workspace/`.

## 2. I-install ang mga paunang kinakailangan (sa VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. I-install ang OpenClaw

Patakbuhin ang OpenClaw install script:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. I-setup ang nginx para i-proxy ang OpenClaw sa port 8000

I-edit ang `/etc/nginx/sites-enabled/default` gamit ang

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

## 5. I-access ang OpenClaw at magbigay ng mga pribilehiyo

I-access ang `https://<vm-name>.exe.xyz/` (tingnan ang output ng Control UI mula sa onboarding). Kung humingi ito ng auth, i-paste ang
token mula sa `gateway.auth.token` sa VM (kunin gamit ang `openclaw config get gateway.auth.token`, o gumawa ng bago
gamit ang `openclaw doctor --generate-gateway-token`). I-approve ang mga device gamit ang `openclaw devices list` at
`openclaw devices approve <requestId>`. Kapag may pagdududa, gamitin si Shelley mula sa iyong browser!

## Remote Access

Ang remote access ay pinangangasiwaan ng authentication ng [exe.dev](https://exe.dev). Bilang
default, ang HTTP traffic mula sa port 8000 ay ipinapasa sa `https://<vm-name>.exe.xyz`
na may email auth.

## Pag-update

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Gabay: [Updating](/install/updating)
