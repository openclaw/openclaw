---
summary: "„OpenClaw Gateway auf exe.dev (VM + HTTPS-Proxy) für den Remote-Zugriff ausführen“"
read_when:
  - Sie möchten einen günstigen, dauerhaft aktiven Linux-Host für das Gateway
  - Sie möchten Remote-Zugriff auf die Control UI, ohne einen eigenen VPS zu betreiben
title: "exe.dev"
---

# exe.dev

Ziel: OpenClaw Gateway läuft auf einer exe.dev-VM und ist von Ihrem Laptop erreichbar über: `https://<vm-name>.exe.xyz`

Diese Seite geht vom exe.dev-Standardimage **exeuntu** aus. Wenn Sie eine andere Distribution gewählt haben, passen Sie die Pakete entsprechend an.

## Beginner-Schnellpfad

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Geben Sie bei Bedarf Ihren Auth-Key/Token ein
3. Klicken Sie neben Ihrer VM auf „Agent“ und warten Sie …
4. ???
5. Profit

## Was Sie benötigen

- exe.dev-Konto
- `ssh exe.dev` Zugriff auf [exe.dev](https://exe.dev) Virtual Machines (optional)

## Automatisierte Installation mit Shelley

Shelley, der Agent von [exe.dev](https://exe.dev), kann OpenClaw mit unserem Prompt sofort installieren. Der verwendete Prompt lautet wie folgt:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Manuelle Installation

## 1. VM erstellen

Von Ihrem Gerät aus:

```bash
ssh exe.dev new
```

Dann verbinden:

```bash
ssh <vm-name>.exe.xyz
```

Tipp: Halten Sie diese VM **stateful**. OpenClaw speichert den Zustand unter `~/.openclaw/` und `~/.openclaw/workspace/`.

## 2. Voraussetzungen installieren (auf der VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. OpenClaw installieren

Führen Sie das OpenClaw-Installationsskript aus:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. nginx einrichten, um OpenClaw auf Port 8000 zu proxyn

Bearbeiten Sie `/etc/nginx/sites-enabled/default` mit

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

## 5. Auf OpenClaw zugreifen und Berechtigungen erteilen

Greifen Sie auf `https://<vm-name>.exe.xyz/` zu (siehe die Ausgabe der Control UI aus dem Onboarding). Wenn zur Authentifizierung aufgefordert wird, fügen Sie
den Token aus `gateway.auth.token` auf der VM ein (abrufen mit `openclaw config get gateway.auth.token` oder
einen generieren mit `openclaw doctor --generate-gateway-token`). Genehmigen Sie Geräte mit `openclaw devices list` und
`openclaw devices approve <requestId>`. Im Zweifel nutzen Sie Shelley direkt aus Ihrem Browser!

## Remote-Zugriff

Der Remote-Zugriff wird über die Authentifizierung von [exe.dev](https://exe.dev) abgewickelt. Standardmäßig wird
HTTP-Traffic von Port 8000 an `https://<vm-name>.exe.xyz`
mit E-Mail-Authentifizierung weitergeleitet.

## Aktualisierung

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Anleitung: [Updating](/install/updating)
