---
summary: "Exécuter la passerelle OpenClaw sur exe.dev (VM + proxy HTTPS) pour accès distant"
read_when:
  - Vous voulez un hôte Linux toujours actif peu coûteux pour la passerelle
  - Vous voulez un accès distant à l'interface de contrôle sans gérer votre propre VPS
title: "exe.dev"
---

# exe.dev

Objectif : Passerelle OpenClaw fonctionnant sur une VM exe.dev, accessible depuis votre ordinateur portable via : `https://<nom-vm>.exe.xyz`

Cette page suppose l'image **exeuntu** par défaut d'exe.dev. Si vous avez choisi une distribution différente, adaptez les packages en conséquence.

## Chemin rapide débutant

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Remplissez votre clé/jeton d'authentification selon les besoins
3. Cliquez sur "Agent" à côté de votre VM, et attendez...
4. ???
5. Profit

## Ce dont vous avez besoin

- Compte exe.dev
- Accès `ssh exe.dev` aux machines virtuelles [exe.dev](https://exe.dev) (optionnel)

## Installation automatisée avec Shelley

Shelley, l'agent [exe.dev](https://exe.dev), peut installer OpenClaw instantanément avec notre
invite. L'invite utilisée est la suivante :

```
Configurez OpenClaw (https://docs.openclaw.ai/install) sur cette VM. Utilisez les options non-interactives et d'acceptation de risque pour la configuration initiale openclaw. Ajoutez l'authentification ou le jeton fourni selon les besoins. Configurez nginx pour transférer depuis le port par défaut 18789 vers l'emplacement racine sur la configuration du site activé par défaut, en vous assurant d'activer le support Websocket. L'appairage se fait par "openclaw devices list" et "openclaw device approve <request id>". Assurez-vous que le tableau de bord montre que la santé d'OpenClaw est OK. exe.dev gère le transfert du port 8000 vers le port 80/443 et HTTPS pour nous, donc le "reachable" final devrait être <nom-vm>.exe.xyz, sans spécification de port.
```

## Installation manuelle

## 1) Créer la VM

Depuis votre appareil :

```bash
ssh exe.dev new
```

Ensuite connectez-vous :

```bash
ssh <nom-vm>.exe.xyz
```

Astuce : gardez cette VM **avec état**. OpenClaw stocke l'état sous `~/.openclaw/` et `~/.openclaw/workspace/`.

## 2) Installer les prérequis (sur la VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) Installer OpenClaw

Exécutez le script d'installation OpenClaw :

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) Configurer nginx pour proxy OpenClaw vers le port 8000

Éditez `/etc/nginx/sites-enabled/default` avec

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

        # Support WebSocket
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # En-têtes proxy standard
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Paramètres timeout pour connexions longue durée
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5) Accéder à OpenClaw et accorder les privilèges

Accédez à `https://<nom-vm>.exe.xyz/` (voir la sortie interface de contrôle depuis la configuration initiale). Si cela demande une authentification, collez le
jeton de `gateway.auth.token` sur la VM (récupérez avec `openclaw config get gateway.auth.token`, ou générez-en un
avec `openclaw doctor --generate-gateway-token`). Approuvez les appareils avec `openclaw devices list` et
`openclaw devices approve <requestId>`. En cas de doute, utilisez Shelley depuis votre navigateur !

## Accès distant

L'accès distant est géré par l'authentification [exe.dev](https://exe.dev). Par
défaut, le trafic HTTP depuis le port 8000 est transféré vers `https://<nom-vm>.exe.xyz`
avec authentification email.

## Mise à jour

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Guide : [Mise à jour](/fr-FR/install/updating)
