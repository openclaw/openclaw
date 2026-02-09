---
summary: "Runbook pour le service Gateway, son cycle de vie et ses opérations"
read_when:
  - Lors de l’exécution ou du débogage du processus gateway
title: "Runbook du Gateway"
---

# Runbook du service Gateway

Dernière mise à jour : 2025-12-09

## Ce que c’est

- Le processus toujours actif qui possède l’unique connexion Baileys/Telegram ainsi que le plan de contrôle/d’événements.
- Remplace la commande héritée `gateway`. Point d’entrée CLI : `openclaw gateway`.
- S’exécute jusqu’à arrêt ; quitte avec un code non nul en cas d’erreur fatale afin que le superviseur le redémarre.

## Comment l’exécuter (local)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Le rechargement à chaud de la configuration surveille `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`).
  - Mode par défaut : `gateway.reload.mode="hybrid"` (application à chaud des changements sûrs, redémarrage pour les changements critiques).
  - Le rechargement à chaud utilise un redémarrage intra-processus via **SIGUSR1** si nécessaire.
  - Désactiver avec `gateway.reload.mode="off"`.
- Lie le plan de contrôle WebSocket à `127.0.0.1:<port>` (par défaut 18789).
- Le même port sert également HTTP (UI de contrôle, hooks, A2UI). Multiplexage sur un port unique.
  - OpenAI Chat Completions (HTTP) : [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP) : [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP) : [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Démarre par défaut un serveur de fichiers Canvas sur `canvasHost.port` (par défaut `18793`), servant `http://<gateway-host>:18793/__openclaw__/canvas/` depuis `~/.openclaw/workspace/canvas`. Désactiver avec `canvasHost.enabled=false` ou `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Journalise sur stdout ; utilisez launchd/systemd pour le maintenir actif et faire la rotation des logs.
- Passez `--verbose` pour dupliquer les logs de débogage (handshakes, req/res, événements) du fichier de log vers stdio lors du dépannage.
- `--force` utilise `lsof` pour trouver les écouteurs sur le port choisi, envoie SIGTERM, journalise ce qu’il a arrêté, puis démarre le gateway (échec rapide si `lsof` est manquant).
- Si vous exécutez sous un superviseur (launchd/systemd/mode processus enfant de l’app mac), un arrêt/redémarrage envoie généralement **SIGTERM** ; les anciennes versions peuvent exposer cela comme `pnpm` `ELIFECYCLE` avec le code de sortie **143** (SIGTERM), ce qui correspond à un arrêt normal, pas à un crash.
- **SIGUSR1** déclenche un redémarrage intra-processus lorsqu’il est autorisé (outil gateway / application de configuration / mise à jour, ou activez `commands.restart` pour les redémarrages manuels).
- L’authentification Gateway est requise par défaut : définissez `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`) ou `gateway.auth.password`. Les clients doivent envoyer `connect.params.auth.token/password` sauf s’ils utilisent l’identité Tailscale Serve.
- L'assistant génère désormais un jeton par défaut, même en cas de rebouclage.
- Priorité des ports : `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > valeur par défaut `18789`.

## Accès distant

- Tailscale/VPN recommandé ; sinon tunnel SSH :

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Les clients se connectent ensuite à `ws://127.0.0.1:18789` via le tunnel.

- Si un jeton est configuré, les clients doivent l’inclure dans `connect.params.auth.token` même via le tunnel.

## Gateways multiples (même hôte)

Généralement inutile : un Gateway peut servir plusieurs canaux de messagerie et agents. Utilisez plusieurs Gateways uniquement pour la redondance ou une isolation stricte (ex. bot de secours).

Pris en charge si vous isolez l’état + la configuration et utilisez des ports uniques. Guide complet : [Multiple gateways](/gateway/multiple-gateways).

Les noms de service sont sensibles au profil :

- macOS : `bot.molt.<profile>` (l’héritage `com.openclaw.*` peut encore exister)
- Linux : `openclaw-gateway-<profile>.service`
- Windows : `OpenClaw Gateway (<profile>)`

Les métadonnées d’installation sont intégrées dans la configuration du service :

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Modèle « Rescue-Bot » : conserver un second Gateway isolé avec son propre profil, répertoire d’état, espace de travail et espacement de ports de base. Guide complet : [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### Profil dev (`--dev`)

Voie rapide : exécuter une instance dev entièrement isolée (config/état/espace de travail) sans toucher à votre configuration principale.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Valeurs par défaut (peuvent être remplacées via env/flags/config) :

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- port du service de contrôle navigateur = `19003` (dérivé : `gateway.port+2`, loopback uniquement)
- `canvasHost.port=19005` (dérivé : `gateway.port+4`)
- `agents.defaults.workspace` devient par défaut `~/.openclaw/workspace-dev` lorsque vous exécutez `setup`/`onboard` sous `--dev`.

Ports dérivés (règles empiriques) :

- Port de base = `gateway.port` (ou `OPENCLAW_GATEWAY_PORT` / `--port`)
- Port du service de contrôle navigateur = base + 2 (loopback uniquement)
- `canvasHost.port = base + 4` (ou `OPENCLAW_CANVAS_HOST_PORT` / surcharge de configuration)
- Les ports CDP du profil navigateur s’allouent automatiquement à partir de `browser.controlPort + 9 .. + 108` (persistés par profil).

Checklist par instance :

- `gateway.port` unique
- `OPENCLAW_CONFIG_PATH` unique
- `OPENCLAW_STATE_DIR` unique
- `agents.defaults.workspace` unique
- Numéros WhatsApp distincts (si WA est utilisé)

Installation du service par profil :

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Exemple :

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protocole (vue opérateur)

- Documentation complète : [Gateway protocol](/gateway/protocol) et [Bridge protocol (legacy)](/gateway/bridge-protocol).
- Trame initiale obligatoire du client : `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Le Gateway répond `res {type:"res", id, ok:true, payload:hello-ok }` (ou `ok:false` avec une erreur, puis ferme).
- Après le handshake :
  - Requêtes : `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Événements : `{type:"event", event, payload, seq?, stateVersion?}`
- Entrées de présence structurées : `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (pour les clients WS, `instanceId` provient de `connect.client.instanceId`).
- Les réponses `agent` sont en deux étapes : d’abord un accusé `res` `{runId,status:"accepted"}`, puis un `res` final `{runId,status:"ok"|"error",summary}` après la fin de l’exécution ; la sortie streamée arrive sous forme de `event:"agent"`.

## Méthodes (ensemble initial)

- `health` — instantané de santé complet (même forme que `openclaw health --json`).
- `status` — résumé court.
- `system-presence` — liste de présence actuelle.
- `system-event` — publier une note de présence/système (structurée).
- `send` — envoyer un message via le(s) canal(aux) actif(s).
- `agent` — exécuter un tour d’agent (diffuse les événements sur la même connexion).
- `node.list` — lister les nœuds appariés + actuellement connectés (inclut `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` et les `commands` annoncés).
- `node.describe` — décrire un nœud (capacités + commandes `node.invoke` prises en charge ; fonctionne pour les nœuds appariés et les nœuds non appariés actuellement connectés).
- `node.invoke` — invoquer une commande sur un nœud (ex. `canvas.*`, `camera.*`).
- `node.pair.*` — cycle de vie de l’appariement (`request`, `list`, `approve`, `reject`, `verify`).

Voir aussi : [Presence](/concepts/presence) pour comprendre comment la présence est produite/dédupliquée et pourquoi un `client.instanceId` stable est important.

## Événements

- `agent` — événements d’outil/sortie streamés depuis l’exécution de l’agent (étiquetés par séquence).
- `presence` — mises à jour de présence (deltas avec stateVersion) poussées à tous les clients connectés.
- `tick` — keepalive/no-op périodique pour confirmer la vivacité.
- `shutdown` — le Gateway est en cours d’arrêt ; la charge utile inclut `reason` et éventuellement `restartExpectedMs`. Les clients doivent se reconnecter.

## Intégration WebChat

- WebChat est une UI SwiftUI native qui communique directement avec le WebSocket du Gateway pour l’historique, l’envoi, l’annulation et les événements.
- L’usage à distance passe par le même tunnel SSH/Tailscale ; si un jeton gateway est configuré, le client l’inclut lors de `connect`.
- L’app macOS se connecte via un seul WS (connexion partagée) ; elle hydrate la présence depuis l’instantané initial et écoute les événements `presence` pour mettre à jour l’UI.

## Typage et validation

- Le serveur valide chaque trame entrante avec AJV contre le JSON Schema émis à partir des définitions de protocole.
- Les clients (TS/Swift) consomment des types générés (TS directement ; Swift via le générateur du dépôt).
- Les définitions de protocole sont la source de vérité ; régénérez les schémas/modèles avec :
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Instantané de connexion

- `hello-ok` inclut un `snapshot` avec `presence`, `health`, `stateVersion` et `uptimeMs` ainsi que `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` afin que les clients puissent afficher immédiatement sans requêtes supplémentaires.
- `health`/`system-presence` restent disponibles pour un rafraîchissement manuel, mais ne sont pas requis au moment de la connexion.

## Codes d’erreur (forme res.error)

- Les erreurs utilisent `{ code, message, details?, retryable?, retryAfterMs? }`.
- Codes standards :
  - `NOT_LINKED` — WhatsApp non authentifié.
  - `AGENT_TIMEOUT` — l’agent n’a pas répondu dans le délai configuré.
  - `INVALID_REQUEST` — échec de validation schéma/paramètres.
  - `UNAVAILABLE` — le Gateway s’arrête ou une dépendance est indisponible.

## Comportement keepalive

- Des événements `tick` (ou ping/pong WS) sont émis périodiquement afin que les clients sachent que le Gateway est vivant même en l’absence de trafic.
- Les accusés d’envoi/d’agent restent des réponses distinctes ; ne surchargez pas les ticks pour les envois.

## Relecture / manques

- Les événements ne sont pas rejoués. Les clients détectent les trous de séquence et doivent rafraîchir (`health` + `system-presence`) avant de continuer. WebChat et les clients macOS rafraîchissent désormais automatiquement en cas de trou.

## Supervision (exemple macOS)

- Utilisez launchd pour maintenir le service actif :
  - Program : chemin vers `openclaw`
  - Arguments : `gateway`
  - KeepAlive : true
  - StandardOut/Err : chemins de fichiers ou `syslog`
- En cas d’échec, launchd redémarre ; une mauvaise configuration fatale doit continuer à quitter afin que l’opérateur le remarque.
- Les LaunchAgents sont par utilisateur et nécessitent une session connectée ; pour des configurations headless, utilisez un LaunchDaemon personnalisé (non fourni).
  - `openclaw gateway install` écrit `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (ou `bot.molt.<profile>.plist` ; l’héritage `com.openclaw.*` est nettoyé).
  - `openclaw doctor` audite la configuration LaunchAgent et peut la mettre à jour selon les valeurs par défaut actuelles.

## Gestion du service Gateway (CLI)

Utilisez la CLI Gateway pour installer/démarrer/arrêter/redémarrer/obtenir l’état :

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Notes :

- `gateway status` sonde par défaut le RPC du Gateway en utilisant le port/config résolus du service (surcharge avec `--url`).
- `gateway status --deep` ajoute des analyses au niveau système (LaunchDaemons/unités systemd).
- `gateway status --no-probe` ignore la sonde RPC (utile lorsque le réseau est indisponible).
- `gateway status --json` est stable pour les scripts.
- `gateway status` rapporte le **runtime du superviseur** (launchd/systemd en cours d’exécution) séparément de la **joignabilité RPC** (connexion WS + RPC d’état).
- `gateway status` affiche le chemin de configuration + la cible de sonde pour éviter les confusions « localhost vs liaison LAN » et les décalages de profil.
- `gateway status` inclut la dernière ligne d’erreur du gateway lorsque le service semble en cours d’exécution mais que le port est fermé.
- `logs` suit (tail) le log fichier du Gateway via RPC (aucun `tail`/`grep` manuel nécessaire).
- Si d’autres services de type gateway sont détectés, la CLI avertit sauf s’il s’agit de services de profil OpenClaw.
  Nous recommandons toujours **un gateway par machine** pour la plupart des configurations ; utilisez des profils/ports isolés pour la redondance ou un bot de secours. Voir [Multiple gateways](/gateway/multiple-gateways).
  - Nettoyage : `openclaw gateway uninstall` (service courant) et `openclaw doctor` (migrations héritées).
- `gateway install` est un no-op lorsqu’il est déjà installé ; utilisez `openclaw gateway install --force` pour réinstaller (changements de profil/env/chemin).

App macOS fournie :

- OpenClaw.app peut intégrer un relais gateway basé sur Node et installer un LaunchAgent par utilisateur étiqueté
  `bot.molt.gateway` (ou `bot.molt.<profile>` ; les étiquettes héritées `com.openclaw.*` se déchargent proprement).
- Pour l’arrêter proprement, utilisez `openclaw gateway stop` (ou `launchctl bootout gui/$UID/bot.molt.gateway`).
- Pour redémarrer, utilisez `openclaw gateway restart` (ou `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` fonctionne uniquement si le LaunchAgent est installé ; sinon utilisez d’abord `openclaw gateway install`.
  - Remplacez l’étiquette par `bot.molt.<profile>` lors de l’exécution d’un profil nommé.

## Supervision (unité utilisateur systemd)

OpenClaw installe par défaut un **service utilisateur systemd** sur Linux/WSL2. Nous
recommandons les services utilisateur pour les machines mono-utilisateur (env plus simple, configuration par utilisateur).
Utilisez un **service système** pour les serveurs multi-utilisateurs ou toujours actifs (pas de lingering requis, supervision partagée).

`openclaw gateway install` écrit l’unité utilisateur. `openclaw doctor` audite
l’unité et peut la mettre à jour pour correspondre aux valeurs par défaut recommandées actuelles.

Créez `~/.config/systemd/user/openclaw-gateway[-<profile>].service` :

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

Activez le lingering (requis pour que le service utilisateur survive à la déconnexion/inactivité) :

```
sudo loginctl enable-linger youruser
```

La prise en main exécute ceci sur Linux/WSL2 (peut demander sudo ; écrit `/var/lib/systemd/linger`).
Puis activez le service :

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternative (service système)** — pour les serveurs toujours actifs ou multi-utilisateurs, vous pouvez
installer une unité systemd **système** au lieu d’une unité utilisateur (pas de lingering requis).
Créez `/etc/systemd/system/openclaw-gateway[-<profile>].service` (copiez l’unité ci-dessus,
changez `WantedBy=multi-user.target`, définissez `User=` + `WorkingDirectory=`), puis :

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Les installations Windows doivent utiliser **WSL2** et suivre la section systemd Linux ci-dessus.

## Vérifications opérationnelles

- Vivacité : ouvrir un WS et envoyer `req:connect` → attendre `res` avec `payload.type="hello-ok"` (avec instantané).
- Disponibilité : appeler `health` → attendre `ok: true` et un canal lié dans `linkChannel` (le cas échéant).
- Débogage : s’abonner aux événements `tick` et `presence` ; vérifier que `status` affiche l’âge de liaison/auth ; les entrées de présence affichent l’hôte Gateway et les clients connectés.

## Garanties de sécurité

- Supposer un Gateway par hôte par défaut ; si vous exécutez plusieurs profils, isolez ports/état et ciblez la bonne instance.
- Pas de repli vers des connexions Baileys directes ; si le Gateway est indisponible, les envois échouent immédiatement.
- Les premières trames non conformes ou le JSON malformé sont rejetés et la socket est fermée.
- Arrêt gracieux : émettre l’événement `shutdown` avant la fermeture ; les clients doivent gérer la fermeture + reconnexion.

## Assistants CLI

- `openclaw gateway health|status` — demander l’état/la santé via le WS du Gateway.
- `openclaw message send --target <num> --message "hi" [--media ...]` — envoyer via le Gateway (idempotent pour WhatsApp).
- `openclaw agent --message "hi" --to <num>` — exécuter un tour d’agent (attend le final par défaut).
- `openclaw gateway call <method> --params '{"k":"v"}'` — invocateur de méthodes brutes pour le débogage.
- `openclaw gateway stop|restart` — arrêter/redémarrer le service gateway supervisé (launchd/systemd).
- Les sous-commandes d’assistance Gateway supposent un gateway en cours d’exécution sur `--url` ; elles ne lancent plus automatiquement un gateway.

## Guide de migration

- Retirer les usages de `openclaw gateway` et de l’ancien port de contrôle TCP.
- Mettre à jour les clients pour parler le protocole WS avec connexion obligatoire et présence structurée.
