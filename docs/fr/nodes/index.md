---
summary: "Nœuds : appairage, capacités, autorisations et assistants CLI pour canvas/caméra/écran/système"
read_when:
  - Appairage de nœuds iOS/Android à une passerelle
  - Utilisation du canvas/de la caméra d’un nœud pour le contexte de l’agent
  - Ajout de nouvelles commandes de nœud ou d’assistants CLI
title: "Nœuds"
---

# Nœuds

Un **nœud** est un appareil compagnon (macOS/iOS/Android/sans interface) qui se connecte au **WebSocket** de la Gateway **(passerelle)** (même port que les opérateurs) avec `role: "node"` et expose une surface de commandes (p. ex. `canvas.*`, `camera.*`, `system.*`) via `node.invoke`. Détails du protocole : [Protocole de la Gateway](/gateway/protocol).

Transport hérité : [Protocole Bridge](/gateway/bridge-protocol) (TCP JSONL ; obsolète/supprimé pour les nœuds actuels).

macOS peut aussi fonctionner en **mode nœud** : l’app de la barre de menus se connecte au serveur WS de la Gateway et expose ses commandes locales de canvas/caméra en tant que nœud (ainsi `openclaw nodes …` fonctionne sur ce Mac).

Notes :

- Les nœuds sont des **périphériques**, pas des passerelles. Ils n’exécutent pas le service de passerelle.
- Les messages Telegram/WhatsApp/etc. arrivent sur la **gateway**, pas sur les nœuds.
- Dépannage du runbook : [/nodes/troubleshooting](/nodes/troubleshooting)

## Appairage + statut

**Les nœuds WS utilisent l’appairage d’appareil.** Les nœuds présentent une identité d’appareil pendant `connect` ; la Gateway
crée une demande d’appairage d’appareil pour `role: node`. Approuvez via la CLI (ou l’UI) des appareils.

CLI rapide :

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Notes :

- `nodes status` marque un nœud comme **appairé** lorsque son rôle d’appairage d’appareil inclut `node`.
- `node.pair.*` (CLI : `openclaw nodes pending/approve/reject`) est un magasin d’appairage de nœuds distinct, détenu par la gateway ; il ne **bloque pas** l’handshake WS `connect`.

## Hôte de nœud distant (system.run)

Utilisez un **hôte de nœud** lorsque votre Gateway s’exécute sur une machine et que vous souhaitez que les commandes
s’exécutent sur une autre. Le modèle parle toujours à la **gateway** ; la gateway
transmet les appels `exec` à l’**hôte de nœud** lorsque `host=node` est sélectionné.

### Qu'est-ce qui fonctionne où

- **Hôte de la gateway** : reçoit les messages, exécute le modèle, route les appels d’outils.
- **Hôte de nœud** : exécute `system.run`/`system.which` sur la machine du nœud.
- **Approbations** : appliquées sur l’hôte de nœud via `~/.openclaw/exec-approvals.json`.

### Démarrer un hôte de nœud (premier plan)

Sur la machine du nœud :

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Gateway distante via tunnel SSH (liaison loopback)

Si la Gateway se lie au loopback (`gateway.bind=loopback`, par défaut en mode local),
les hôtes de nœud distants ne peuvent pas se connecter directement. Créez un tunnel SSH et pointez
l’hôte de nœud vers l’extrémité locale du tunnel.

Exemple (hôte de nœud -> hôte de la gateway) :

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Notes :

- Le jeton est `gateway.auth.token` depuis la configuration de la gateway (`~/.openclaw/openclaw.json` sur l’hôte de la gateway).
- `openclaw node run` lit `OPENCLAW_GATEWAY_TOKEN` pour l’authentification.

### Démarrer un hôte de nœud (service)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Appairer + nommer

Sur l’hôte de la gateway :

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Options de nommage :

- `--display-name` sur `openclaw node run` / `openclaw node install` (persistant dans `~/.openclaw/node.json` sur le nœud).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (remplacement côté gateway).

### Mettre les commandes sur liste blanche

Les approbations d’exécution sont **par hôte de nœud**. Ajoutez des entrées de liste blanche depuis la gateway :

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Les approbations résident sur l’hôte de nœud à `~/.openclaw/exec-approvals.json`.

### Pointer l’exécution vers le nœud

Configurer les valeurs par défaut (configuration de la gateway) :

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Ou par session :

```
/exec host=node security=allowlist node=<id-or-name>
```

Une fois défini, tout appel `exec` avec `host=node` s’exécute sur l’hôte de nœud (sous réserve de la liste blanche/approbations du nœud).

Associé :

- [CLI de l’hôte de nœud](/cli/node)
- [Outil Exec](/tools/exec)
- [Approbations Exec](/tools/exec-approvals)

## Invocation de commandes

Bas niveau (RPC brut) :

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Des assistants de plus haut niveau existent pour les workflows courants « donner une pièce jointe MEDIA à l’agent ».

## Captures d’écran (instantanés du canvas)

Si le nœud affiche le Canvas (WebView), `canvas.snapshot` renvoie `{ format, base64 }`.

Assistant CLI (écrit dans un fichier temporaire et affiche `MEDIA:<path>`) :

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Commandes du canvas

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notes :

- `canvas present` accepte des URL ou des chemins de fichiers locaux (`--target`), plus `--x/--y/--width/--height` optionnel pour le positionnement.
- `canvas eval` accepte du JS inline (`--js`) ou un argument positionnel.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notes :

- Seul A2UI v0.8 JSONL est pris en charge (v0.9/createSurface est rejeté).

## Photos + vidéos (caméra du nœud)

Photos (`jpg`) :

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Clips vidéo (`mp4`) :

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notes :

- Le nœud doit être **au premier plan** pour `canvas.*` et `camera.*` (les appels en arrière-plan renvoient `NODE_BACKGROUND_UNAVAILABLE`).
- La durée des clips est plafonnée (actuellement `<= 60s`) pour éviter des charges base64 trop volumineuses.
- Android demandera les autorisations `CAMERA`/`RECORD_AUDIO` lorsque possible ; les autorisations refusées échouent avec `*_PERMISSION_REQUIRED`.

## Enregistrements d’écran (nœuds)

Les nœuds exposent `screen.record` (mp4). Exemple :

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notes :

- `screen.record` nécessite que l’app du nœud soit au premier plan.
- Android affiche l’invite système de capture d’écran avant l’enregistrement.
- Les enregistrements d’écran sont plafonnés à `<= 60s`.
- `--no-audio` désactive la capture du microphone (pris en charge sur iOS/Android ; macOS utilise l’audio de capture système).
- Utilisez `--screen <index>` pour sélectionner un écran lorsque plusieurs sont disponibles.

## Localisation (nœuds)

Les nœuds exposent `location.get` lorsque la localisation est activée dans les paramètres.

Assistant CLI :

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notes :

- La localisation est **désactivée par défaut**.
- « Toujours » requiert une autorisation système ; la récupération en arrière-plan est au mieux.
- La réponse inclut lat/lon, précision (mètres) et horodatage.

## SMS (nœuds Android)

Les nœuds Android peuvent exposer `sms.send` lorsque l’utilisateur accorde l’autorisation **SMS** et que l’appareil prend en charge la téléphonie.

Invocation bas niveau :

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Notes :

- L’invite d’autorisation doit être acceptée sur l’appareil Android avant que la capacité ne soit annoncée.
- Les appareils uniquement Wi‑Fi sans téléphonie n’annonceront pas `sms.send`.

## Commandes système (hôte de nœud / nœud mac)

Le nœud macOS expose `system.run`, `system.notify` et `system.execApprovals.get/set`.
L’hôte de nœud sans interface expose `system.run`, `system.which` et `system.execApprovals.get/set`.

Exemples :

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Notes :

- `system.run` renvoie stdout/stderr/code de sortie dans la charge utile.
- `system.notify` respecte l’état des autorisations de notification dans l’app macOS.
- `system.run` prend en charge `--cwd`, `--env KEY=VAL`, `--command-timeout` et `--needs-screen-recording`.
- `system.notify` prend en charge `--priority <passive|active|timeSensitive>` et `--delivery <system|overlay|auto>`.
- Les nœuds macOS ignorent les remplacements `PATH` ; les hôtes de nœud sans interface n’acceptent `PATH` que lorsqu’il préfixe le PATH de l’hôte de nœud.
- En mode nœud macOS, `system.run` est contrôlé par les approbations Exec dans l’app macOS (Paramètres → Approbations Exec).
  Demander/liste blanche/complet se comportent comme sur l’hôte de nœud sans interface ; les invites refusées renvoient `SYSTEM_RUN_DENIED`.
- Sur l’hôte de nœud sans interface, `system.run` est contrôlé par les approbations Exec (`~/.openclaw/exec-approvals.json`).

## Liaison Exec au nœud

Lorsque plusieurs nœuds sont disponibles, vous pouvez lier Exec à un nœud spécifique.
Cela définit le nœud par défaut pour `exec host=node` (et peut être remplacé par agent).

Valeur par défaut globale :

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Remplacement par agent :

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Désactiver pour autoriser n’importe quel nœud :

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Carte des autorisations

Les nœuds peuvent inclure une carte `permissions` dans `node.list` / `node.describe`, indexée par nom d’autorisation (p. ex. `screenRecording`, `accessibility`) avec des valeurs booléennes (`true` = accordé).

## Hôte de noeud Headless (cross-platform)

OpenClaw peut exécuter un **hôte de nœud sans interface** (sans UI) qui se connecte au WebSocket de la Gateway
et expose `system.run` / `system.which`. C’est utile sous Linux/Windows
ou pour exécuter un nœud minimal à côté d’un serveur.

Démarrage :

```bash
openclaw node run --host <gateway-host> --port 18789
```

Notes :

- L’appairage est toujours requis (la Gateway affichera une invite d’approbation de nœud).
- L’hôte de nœud stocke son identifiant de nœud, son jeton, son nom d’affichage et les informations de connexion à la gateway dans `~/.openclaw/node.json`.
- Les approbations Exec sont appliquées localement via `~/.openclaw/exec-approvals.json`
  (voir [Approbations Exec](/tools/exec-approvals)).
- Sur macOS, l’hôte de nœud sans interface préfère l’hôte d’exécution de l’app compagnon lorsqu’il est joignable et
  bascule vers l’exécution locale si l’app est indisponible. Définissez `OPENCLAW_NODE_EXEC_HOST=app` pour exiger
  l’app, ou `OPENCLAW_NODE_EXEC_FALLBACK=0` pour désactiver le repli.
- Ajoutez `--tls` / `--tls-fingerprint` lorsque le WS de la Gateway utilise TLS.

## Mode nœud Mac

- L’app macOS de la barre de menus se connecte au serveur WS de la Gateway en tant que nœud (ainsi `openclaw nodes …` fonctionne sur ce Mac).
- En mode distant, l’app ouvre un tunnel SSH pour le port de la Gateway et se connecte à `localhost`.
