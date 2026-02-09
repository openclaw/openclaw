---
summary: "Exécuter OpenClaw Gateway sur exe.dev (VM + proxy HTTPS) pour un accès à distance"
read_when:
  - Vous voulez un hôte Linux toujours actif et économique pour la Gateway (passerelle)
  - Vous voulez un accès distant à l’UI de contrôle sans gérer votre propre VPS
title: "exe.dev"
---

# exe.dev

Objectif : OpenClaw Gateway s’exécutant sur une VM exe.dev, accessible depuis votre ordinateur portable via : `https://<vm-name>.exe.xyz`

Cette page suppose l’image **exeuntu** par défaut d’exe.dev. Si vous avez choisi une autre distribution, adaptez les paquets en conséquence.

## Parcours rapide pour debutants

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Renseignez votre clé/token d’authentification si nécessaire
3. Cliquez sur « Agent » à côté de votre VM, puis attendez…
4. ???
5. Profit

## Ce dont vous avez besoin

- Un compte exe.dev
- Un accès `ssh exe.dev` aux machines virtuelles [exe.dev](https://exe.dev) (optionnel)

## Installation automatisée avec Shelley

Shelley, l’agent d’[exe.dev](https://exe.dev), peut installer OpenClaw instantanément à l’aide de notre
prompt. Le prompt utilisé est le suivant :

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Installation manuelle

## 1. Créer la VM

Depuis votre appareil :

```bash
ssh exe.dev new
```

Puis connectez-vous :

```bash
ssh <vm-name>.exe.xyz
```

Astuce : gardez cette VM **stateful**. OpenClaw stocke l’état sous `~/.openclaw/` et `~/.openclaw/workspace/`.

## 2. Installer les prerequis (sur la VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. Installer OpenClaw

Exécutez le script d’installation d’OpenClaw :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. Configurer nginx pour proxifier OpenClaw vers le port 8000

Modifiez `/etc/nginx/sites-enabled/default` avec :

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

## 5. Acceder a OpenClaw et accorder les privileges

Accédez à `https://<vm-name>.exe.xyz/` (voir la sortie de l’UI de contrôle lors de la prise en main). S’il demande une authentification, collez le
token depuis `gateway.auth.token` sur la VM (à récupérer avec `openclaw config get gateway.auth.token`, ou à générer
avec `openclaw doctor --generate-gateway-token`). Approuvez les appareils avec `openclaw devices list` et
`openclaw devices approve <requestId>`. En cas de doute, utilisez Shelley depuis votre navigateur !

## Acces a distance

L’accès à distance est géré par l’authentification d’[exe.dev](https://exe.dev). Par
défaut, le trafic HTTP depuis le port 8000 est redirigé vers `https://<vm-name>.exe.xyz`
avec une authentification par e‑mail.

## Mise à jour

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Guide : [Updating](/install/updating)
