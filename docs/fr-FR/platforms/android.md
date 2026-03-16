---
summary: "Application Android (nœud) : runbook de connexion + Canvas/Chat/Caméra"
read_when:
  - Appairage ou reconnexion du nœud Android
  - Débogage de la découverte de passerelle Android ou de l'auth
  - Vérification de la parité de l'historique de chat entre les clients
title: "Application Android"
---

# Application Android (Nœud)

## Aperçu du support

- Rôle : application nœud compagnon (Android n'héberge pas la Passerelle).
- Passerelle requise : oui (exécutez-la sur macOS, Linux ou Windows via WSL2).
- Installation : [Premiers pas](/fr-FR/start/getting-started) + [Appairage](/fr-FR/gateway/pairing).
- Passerelle : [Runbook](/fr-FR/gateway) + [Configuration](/fr-FR/gateway/configuration).
  - Protocoles : [Protocole Passerelle](/fr-FR/gateway/protocol) (nœuds + plan de contrôle).

## Contrôle système

Le contrôle système (launchd/systemd) vit sur l'hôte Passerelle. Voir [Passerelle](/fr-FR/gateway).

## Runbook de Connexion

Application nœud Android ⇄ (mDNS/NSD + WebSocket) ⇄ **Passerelle**

Android se connecte directement au WebSocket de la Passerelle (par défaut `ws://<host>:18789`) et utilise l'appairage géré par la Passerelle.

### Prérequis

- Vous pouvez exécuter la Passerelle sur la machine "maître".
- L'appareil/émulateur Android peut atteindre le WebSocket de la passerelle :
  - Même LAN avec mDNS/NSD, **ou**
  - Même tailnet Tailscale utilisant Wide-Area Bonjour / DNS-SD unicast (voir ci-dessous), **ou**
  - Hôte/port passerelle manuel (fallback)
- Vous pouvez exécuter le CLI (`openclaw`) sur la machine passerelle (ou via SSH).

### 1) Démarrer la Passerelle

```bash
openclaw gateway --port 18789 --verbose
```

Confirmez dans les logs que vous voyez quelque chose comme :

- `listening on ws://0.0.0.0:18789`

Pour les configurations tailnet uniquement (recommandé pour Vienne ⇄ Londres), liez la passerelle à l'IP tailnet :

- Définir `gateway.bind: "tailnet"` dans `~/.openclaw/openclaw.json` sur l'hôte passerelle.
- Redémarrer la Passerelle / l'application barre de menu macOS.

### 2) Vérifier la découverte (optionnel)

Depuis la machine passerelle :

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Plus de notes de débogage : [Bonjour](/fr-FR/gateway/bonjour).

#### Découverte Tailnet (Vienne ⇄ Londres) via DNS-SD unicast

La découverte Android NSD/mDNS ne traversera pas les réseaux. Si votre nœud Android et la passerelle sont sur des réseaux différents mais connectés via Tailscale, utilisez plutôt Wide-Area Bonjour / DNS-SD unicast :

1. Configurer une zone DNS-SD (exemple `openclaw.internal.`) sur l'hôte passerelle et publier les enregistrements `_openclaw-gw._tcp`.
2. Configurer Tailscale split DNS pour votre domaine choisi pointant vers ce serveur DNS.

Détails et exemple de configuration CoreDNS : [Bonjour](/fr-FR/gateway/bonjour).

### 3) Se connecter depuis Android

Dans l'application Android :

- L'application maintient sa connexion passerelle active via un **service de premier plan** (notification persistante).
- Ouvrir **Réglages**.
- Sous **Passerelles Découvertes**, sélectionner votre passerelle et appuyer sur **Connecter**.
- Si mDNS est bloqué, utiliser **Avancé → Passerelle Manuelle** (hôte + port) et **Connecter (Manuel)**.

Après le premier appairage réussi, Android se reconnecte automatiquement au lancement :

- Endpoint manuel (si activé), sinon
- La dernière passerelle découverte (au mieux).

### 4) Approuver l'appairage (CLI)

Sur la machine passerelle :

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Détails de l'appairage : [Appairage Passerelle](/fr-FR/gateway/pairing).

### 5) Vérifier que le nœud est connecté

- Via statut des nœuds :

  ```bash
  openclaw nodes status
  ```

- Via Passerelle :

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) Chat + historique

La feuille Chat du nœud Android utilise la **clé de session principale** de la passerelle (`main`), donc l'historique et les réponses sont partagés avec WebChat et d'autres clients :

- Historique : `chat.history`
- Envoyer : `chat.send`
- Mises à jour push (au mieux) : `chat.subscribe` → `event:"chat"`

### 7) Canvas + caméra

#### Hôte Canvas de la Passerelle (recommandé pour le contenu web)

Si vous voulez que le nœud affiche du vrai HTML/CSS/JS que l'agent peut éditer sur disque, pointez le nœud vers l'hôte canvas de la Passerelle.

Remarque : les nœuds chargent le canvas depuis le serveur HTTP de la Passerelle (même port que `gateway.port`, par défaut `18789`).

1. Créer `~/.openclaw/workspace/canvas/index.html` sur l'hôte passerelle.

2. Naviguer le nœud vers celui-ci (LAN) :

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

Tailnet (optionnel) : si les deux appareils sont sur Tailscale, utilisez un nom MagicDNS ou une IP tailnet au lieu de `.local`, par ex. `http://<gateway-magicdns>:18789/__openclaw__/canvas/`.

Ce serveur injecte un client de rechargement en direct dans le HTML et recharge lors des modifications de fichiers.
L'hôte A2UI se trouve à `http://<gateway-host>:18789/__openclaw__/a2ui/`.

Commandes Canvas (premier plan uniquement) :

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (utilisez `{"url":""}` ou `{"url":"/"}` pour retourner au scaffold par défaut). `canvas.snapshot` retourne `{ format, base64 }` (par défaut `format="jpeg"`).
- A2UI : `canvas.a2ui.push`, `canvas.a2ui.reset` (alias legacy `canvas.a2ui.pushJSONL`)

Commandes Caméra (premier plan uniquement ; gérées par permission) :

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Voir [Nœud Caméra](/fr-FR/nodes/camera) pour les paramètres et helpers CLI.
