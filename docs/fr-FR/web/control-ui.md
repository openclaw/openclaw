---
summary: "UI de contrôle basée sur navigateur pour la Passerelle (chat, nœuds, config)"
read_when:
  - Vous voulez opérer la Passerelle depuis un navigateur
  - Vous voulez l'accès Tailnet sans tunnels SSH
title: "UI de contrôle"
---

# UI de contrôle (navigateur)

L'UI de contrôle est une petite application monopage **Vite + Lit** servie par la Passerelle :

- par défaut : `http://<hôte>:18789/`
- préfixe optionnel : définir `gateway.controlUi.basePath` (ex. `/openclaw`)

Elle parle **directement au WebSocket de Passerelle** sur le même port.

## Ouverture rapide (local)

Si la Passerelle tourne sur le même ordinateur, ouvrez :

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (ou [http://localhost:18789/](http://localhost:18789/))

Si la page ne charge pas, démarrez d'abord la Passerelle : `openclaw gateway`.

L'authentification est fournie pendant la poignée de main WebSocket via :

- `connect.params.auth.token`
- `connect.params.auth.password`
  Le panneau de paramètres du tableau de bord vous permet de stocker un token ; les mots de passe ne sont pas persistés.
  L'assistant d'onboarding génère un token de passerelle par défaut, donc collez-le ici lors de la première connexion.

## Appairage d'appareil (première connexion)

Quand vous vous connectez à l'UI de contrôle depuis un nouveau navigateur ou appareil, la Passerelle
nécessite une **approbation d'appairage unique** — même si vous êtes sur le même Tailnet
avec `gateway.auth.allowTailscale: true`. C'est une mesure de sécurité pour empêcher
l'accès non autorisé.

**Ce que vous verrez :** "disconnected (1008): pairing required"

**Pour approuver l'appareil :**

```bash
# Lister les requêtes en attente
openclaw devices list

# Approuver par ID de requête
openclaw devices approve <requestId>
```

Une fois approuvé, l'appareil est mémorisé et ne nécessitera pas de ré-approbation sauf si
vous le révoquez avec `openclaw devices revoke --device <id> --role <role>`. Voir
[CLI Devices](/fr-FR/cli/devices) pour la rotation et révocation de token.

**Notes :**

- Les connexions locales (`127.0.0.1`) sont auto-approuvées.
- Les connexions distantes (LAN, Tailnet, etc.) nécessitent une approbation explicite.
- Chaque profil de navigateur génère un ID d'appareil unique, donc changer de navigateur ou
  effacer les données du navigateur nécessitera un ré-appairage.

## Ce qu'elle peut faire (aujourd'hui)

- Chatter avec le modèle via le WS de Passerelle (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Streamer les appels d'outils + cartes de sortie d'outil en direct dans le Chat (événements d'agent)
- Canaux : WhatsApp/Telegram/Discord/Slack + canaux de plugin (Mattermost, etc.) statut + connexion QR + config par canal (`channels.status`, `web.login.*`, `config.patch`)
- Instances : liste de présence + rafraîchir (`system-presence`)
- Sessions : lister + remplacements thinking/verbose par session (`sessions.list`, `sessions.patch`)
- Tâches cron : lister/ajouter/exécuter/activer/désactiver + historique d'exécution (`cron.*`)
- Compétences : statut, activer/désactiver, installer, mises à jour de clé API (`skills.*`)
- Nœuds : lister + capacités (`node.list`)
- Approbations exec : éditer les listes blanches de passerelle ou nœud + politique ask pour `exec host=gateway/node` (`exec.approvals.*`)
- Config : voir/éditer `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Config : appliquer + redémarrer avec validation (`config.apply`) et réveiller la dernière session active
- Les écritures de config incluent une garde base-hash pour empêcher l'écrasement d'éditions concurrentes
- Schéma de config + rendu de formulaire (`config.schema`, incluant les schémas de plugin + canal) ; l'éditeur JSON brut reste disponible
- Debug : instantanés status/health/models + journal d'événements + appels RPC manuels (`status`, `health`, `models.list`)
- Logs : tail en direct des journaux de fichier de passerelle avec filtre/export (`logs.tail`)
- Mise à jour : exécuter une mise à jour package/git + redémarrer (`update.run`) avec un rapport de redémarrage

Notes du panneau de tâches cron :

- Pour les tâches isolées, la livraison par défaut est annonce résumé. Vous pouvez passer à aucune si vous voulez des exécutions internes uniquement.
- Les champs canal/cible apparaissent quand annonce est sélectionné.

## Comportement du chat

- `chat.send` est **non-bloquant** : il confirme immédiatement avec `{ runId, status: "started" }` et la réponse streame via des événements `chat`.
- Renvoyer avec la même `idempotencyKey` retourne `{ status: "in_flight" }` pendant l'exécution, et `{ status: "ok" }` après complétion.
- `chat.inject` ajoute une note d'assistant à la transcription de session et diffuse un événement `chat` pour les mises à jour UI uniquement (pas d'exécution d'agent, pas de livraison de canal).
- Arrêt :
  - Cliquer **Stop** (appelle `chat.abort`)
  - Taper `/stop` (ou `stop|esc|abort|wait|exit|interrupt`) pour avorter hors bande
  - `chat.abort` supporte `{ sessionKey }` (pas de `runId`) pour avorter toutes les exécutions actives pour cette session

## Accès Tailnet (recommandé)

### Tailscale Serve intégré (préféré)

Gardez la Passerelle sur loopback et laissez Tailscale Serve la proxyfier avec HTTPS :

```bash
openclaw gateway --tailscale serve
```

Ouvrez :

- `https://<magicdns>/` (ou votre `gateway.controlUi.basePath` configuré)

Par défaut, les requêtes Serve peuvent s'authentifier via les en-têtes d'identité Tailscale
(`tailscale-user-login`) quand `gateway.auth.allowTailscale` est `true`. OpenClaw
vérifie l'identité en résolvant l'adresse `x-forwarded-for` avec
`tailscale whois` et en la faisant correspondre à l'en-tête, et n'accepte cela que quand la
requête atteint loopback avec les en-têtes `x-forwarded-*` de Tailscale. Définissez
`gateway.auth.allowTailscale: false` (ou forcez `gateway.auth.mode: "password"`)
si vous voulez exiger un token/mot de passe même pour le trafic Serve.

### Lier au tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Puis ouvrez :

- `http://<tailscale-ip>:18789/` (ou votre `gateway.controlUi.basePath` configuré)

Collez le token dans les paramètres UI (envoyé comme `connect.params.auth.token`).

## HTTP non sécurisé

Si vous ouvrez le tableau de bord sur HTTP simple (`http://<lan-ip>` ou `http://<tailscale-ip>`),
le navigateur s'exécute dans un **contexte non sécurisé** et bloque WebCrypto. Par défaut,
OpenClaw **bloque** les connexions UI de contrôle sans identité d'appareil.

**Correction recommandée :** utilisez HTTPS (Tailscale Serve) ou ouvrez l'UI localement :

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (sur l'hôte de passerelle)

**Exemple de downgrade (token uniquement sur HTTP) :**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "remplacez-moi" },
  },
}
```

Cela désactive l'identité d'appareil + appairage pour l'UI de contrôle (même sur HTTPS). Utilisez
uniquement si vous faites confiance au réseau.

Voir [Tailscale](/fr-FR/gateway/tailscale) pour les conseils de configuration HTTPS.

## Construire l'UI

La Passerelle sert les fichiers statiques depuis `dist/control-ui`. Construisez-les avec :

```bash
pnpm ui:build # auto-installe les dépendances UI au premier lancement
```

Base absolue optionnelle (quand vous voulez des URLs d'assets fixes) :

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Pour le développement local (serveur dev séparé) :

```bash
pnpm ui:dev # auto-installe les dépendances UI au premier lancement
```

Puis pointez l'UI vers votre URL WS de Passerelle (ex. `ws://127.0.0.1:18789`).

## Débogage/test : serveur dev + Passerelle distante

L'UI de contrôle est des fichiers statiques ; la cible WebSocket est configurable et peut être
différente de l'origine HTTP. C'est pratique quand vous voulez le serveur dev Vite
localement mais la Passerelle s'exécute ailleurs.

1. Démarrez le serveur dev UI : `pnpm ui:dev`
2. Ouvrez une URL comme :

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Authentification unique optionnelle (si nécessaire) :

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Notes :

- `gatewayUrl` est stocké dans localStorage après chargement et supprimé de l'URL.
- `token` est stocké dans localStorage ; `password` est gardé en mémoire uniquement.
- Quand `gatewayUrl` est défini, l'UI ne replie pas vers les identifiants de config ou d'environnement.
  Fournissez `token` (ou `password`) explicitement. Les identifiants explicites manquants sont une erreur.
- Utilisez `wss://` quand la Passerelle est derrière TLS (Tailscale Serve, proxy HTTPS, etc.).
- `gatewayUrl` est uniquement accepté dans une fenêtre de niveau supérieur (pas intégré) pour empêcher le clickjacking.
- Pour les configurations dev cross-origin (ex. `pnpm ui:dev` vers une Passerelle distante), ajoutez l'origine UI
  à `gateway.controlUi.allowedOrigins`.

Exemple :

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Détails de configuration d'accès distant : [Accès distant](/fr-FR/gateway/remote).
