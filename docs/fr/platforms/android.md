---
summary: "Application Android (nœud) : runbook de connexion + Canvas/Chat/Camera"
read_when:
  - Appairage ou reconnexion du nœud Android
  - Débogage de la découverte ou de l’authentification de la Gateway Android
  - Vérification de la parité de l’historique de chat entre les clients
title: "Application Android"
---

# Application Android (nœud)

## Aperçu du support

- Rôle : application de nœud compagnon (Android n’héberge pas la Gateway).
- Gateway requise : oui (exécutez-la sur macOS, Linux ou Windows via WSL2).
- Installation : [Premiers pas](/start/getting-started) + [Appairage](/gateway/pairing).
- Gateway : [Runbook](/gateway) + [Configuration](/gateway/configuration).
  - Protocoles : [Protocole de la Gateway](/gateway/protocol) (nœuds + plan de contrôle).

## Contrôle système

Le contrôle système (launchd/systemd) réside sur l’hôte de la Gateway. Voir [Gateway](/gateway).

## Runbook de connexion

Application nœud Android ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android se connecte directement au WebSocket de la Gateway (par défaut `ws://<host>:18789`) et utilise l’appairage détenu par la Gateway.

### Prérequis

- Vous pouvez exécuter la Gateway sur la machine « maître ».
- L’appareil/émulateur Android peut atteindre le WebSocket de la Gateway :
  - Même LAN avec mDNS/NSD, **ou**
  - Même tailnet Tailscale en utilisant Wide-Area Bonjour / DNS-SD unicast (voir ci-dessous), **ou**
  - Hôte/port de la Gateway saisis manuellement (solution de secours)
- Vous pouvez exécuter la CLI (`openclaw`) sur la machine de la Gateway (ou via SSH).

### 1. Démarrer la Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Confirmez dans les logs que vous voyez quelque chose comme :

- `listening on ws://0.0.0.0:18789`

Pour des configurations uniquement via tailnet (recommandé pour Vienne ⇄ Londres), liez la Gateway à l’IP du tailnet :

- Définissez `gateway.bind: "tailnet"` dans `~/.openclaw/openclaw.json` sur l’hôte de la Gateway.
- Redémarrez la Gateway / l’app de barre de menus macOS.

### 2. Vérifier la découverte (optionnel)

Depuis la machine de la Gateway :

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Notes de débogage supplémentaires : [Bonjour](/gateway/bonjour).

#### Découverte via DNS-SD unicast du tailnet (Vienne ⇄ Londres)

La découverte Android NSD/mDNS ne traverse pas les réseaux. Si votre nœud Android et la Gateway sont sur des réseaux différents mais connectés via Tailscale, utilisez plutôt Wide-Area Bonjour / DNS-SD unicast :

1. Configurez une zone DNS-SD (exemple `openclaw.internal.`) sur l’hôte de la Gateway et publiez des enregistrements `_openclaw-gw._tcp`.
2. Configurez le split DNS Tailscale pour votre domaine choisi en pointant vers ce serveur DNS.

Détails et exemple de configuration CoreDNS : [Bonjour](/gateway/bonjour).

### 3. Se connecter depuis Android

Dans l’application Android :

- L’application maintient la connexion à la Gateway via un **service au premier plan** (notification persistante).
- Ouvrez **Paramètres**.
- Sous **Gateways découvertes**, sélectionnez votre Gateway et appuyez sur **Connecter**.
- Si mDNS est bloqué, utilisez **Avancé → Gateway manuelle** (hôte + port) et **Connecter (manuel)**.

Après le premier appairage réussi, Android se reconnecte automatiquement au lancement :

- Point de terminaison manuel (s’il est activé), sinon
- La dernière Gateway découverte (meilleur effort).

### 4. Approuver l’appairage (CLI)

Sur la machine de la Gateway :

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Détails de l’appairage : [Appairage de la Gateway](/gateway/pairing).

### 5. Vérifier que le nœud est connecté

- Via l’état des nœuds :

  ```bash
  openclaw nodes status
  ```

- Via la Gateway :

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Chat + historique

La feuille Chat du nœud Android utilise la **clé de session primaire** de la Gateway (`main`), de sorte que l’historique et les réponses sont partagés avec WebChat et les autres clients :

- Historique : `chat.history`
- Envoi : `chat.send`
- Mises à jour push (meilleur effort) : `chat.subscribe` → `event:"chat"`

### 7. Canvas + caméra

#### Hôte Canvas de la Gateway (recommandé pour le contenu web)

Si vous souhaitez que le nœud affiche de vrais HTML/CSS/JS que l’agent peut modifier sur disque, pointez le nœud vers l’hôte Canvas de la Gateway.

Remarque : les nœuds utilisent l’hôte Canvas autonome sur `canvasHost.port` (par défaut `18793`).

1. Créez `~/.openclaw/workspace/canvas/index.html` sur l’hôte de la Gateway.

2. Naviguez le nœud vers celui-ci (LAN) :

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (optionnel) : si les deux appareils sont sur Tailscale, utilisez un nom MagicDNS ou une IP de tailnet à la place de `.local`, par exemple `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

Ce serveur injecte un client de rechargement à chaud dans le HTML et recharge lors des modifications de fichiers.
L’hôte A2UI se trouve à `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Commandes Canvas (premier plan uniquement) :

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (utilisez `{"url":""}` ou `{"url":"/"}` pour revenir à l’échafaudage par défaut). `canvas.snapshot` renvoie `{ format, base64 }` (par défaut `format="jpeg"`).
- A2UI : `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` alias hérité)

Commandes caméra (premier plan uniquement ; permissions requises) :

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Voir [Nœud caméra](/nodes/camera) pour les paramètres et les aides CLI.
