---
summary: "Référence CLI OpenClaw pour les commandes, sous-commandes et options `openclaw`"
read_when:
  - Ajout ou modification de commandes ou options CLI
  - Documentation de nouvelles surfaces de commande
title: "Référence CLI"
---

# Référence CLI

Cette page décrit le comportement CLI actuel. Si les commandes changent, mettez à jour cette doc.

## Pages de commande

- [`setup`](/fr-FR/cli/setup)
- [`onboard`](/fr-FR/cli/onboard)
- [`configure`](/fr-FR/cli/configure)
- [`config`](/fr-FR/cli/config)
- [`doctor`](/fr-FR/cli/doctor)
- [`dashboard`](/fr-FR/cli/dashboard)
- [`reset`](/fr-FR/cli/reset)
- [`uninstall`](/fr-FR/cli/uninstall)
- [`update`](/fr-FR/cli/update)
- [`message`](/fr-FR/cli/message)
- [`agent`](/fr-FR/cli/agent)
- [`agents`](/fr-FR/cli/agents)
- [`acp`](/fr-FR/cli/acp)
- [`status`](/fr-FR/cli/status)
- [`health`](/fr-FR/cli/health)
- [`sessions`](/fr-FR/cli/sessions)
- [`gateway`](/fr-FR/cli/gateway)
- [`logs`](/fr-FR/cli/logs)
- [`system`](/fr-FR/cli/system)
- [`models`](/fr-FR/cli/models)
- [`memory`](/fr-FR/cli/memory)
- [`nodes`](/fr-FR/cli/nodes)
- [`devices`](/fr-FR/cli/devices)
- [`node`](/fr-FR/cli/node)
- [`approvals`](/fr-FR/cli/approvals)
- [`sandbox`](/fr-FR/cli/sandbox)
- [`tui`](/fr-FR/cli/tui)
- [`browser`](/fr-FR/cli/browser)
- [`cron`](/fr-FR/cli/cron)
- [`dns`](/fr-FR/cli/dns)
- [`docs`](/fr-FR/cli/docs)
- [`hooks`](/fr-FR/cli/hooks)
- [`webhooks`](/fr-FR/cli/webhooks)
- [`pairing`](/fr-FR/cli/pairing)
- [`plugins`](/fr-FR/cli/plugins) (commandes de plugin)
- [`channels`](/fr-FR/cli/channels)
- [`security`](/fr-FR/cli/security)
- [`skills`](/fr-FR/cli/skills)
- [`voicecall`](/fr-FR/cli/voicecall) (plugin ; si installé)

## Drapeaux globaux

- `--dev` : isoler l'état sous `~/.openclaw-dev` et décaler les ports par défaut.
- `--profile <name>` : isoler l'état sous `~/.openclaw-<name>`.
- `--no-color` : désactiver les couleurs ANSI.
- `--update` : raccourci pour `openclaw update` (installations source uniquement).
- `-V`, `--version`, `-v` : afficher la version et quitter.

## Stylisation de sortie

- Les couleurs ANSI et indicateurs de progression ne s'affichent que dans les sessions TTY.
- Les hyperliens OSC-8 s'affichent comme liens cliquables dans les terminaux supportés ; sinon nous revenons aux URL brutes.
- `--json` (et `--plain` quand supporté) désactive la stylisation pour une sortie propre.
- `--no-color` désactive la stylisation ANSI ; `NO_COLOR=1` est également respecté.
- Les commandes longues affichent un indicateur de progression (OSC 9;4 quand supporté).

## Palette de couleurs

OpenClaw utilise une palette lobster pour la sortie CLI.

- `accent` (#FF5A2D) : titres, étiquettes, surlignages principaux.
- `accentBright` (#FF7A3D) : noms de commande, emphase.
- `accentDim` (#D14A22) : texte de surlignage secondaire.
- `info` (#FF8A5B) : valeurs informationnelles.
- `success` (#2FBF71) : états de succès.
- `warn` (#FFB020) : avertissements, solutions de secours, attention.
- `error` (#E23D2D) : erreurs, échecs.
- `muted` (#8B7F77) : dé-emphase, métadonnées.

Source de vérité de la palette : `src/terminal/palette.ts` (alias "lobster seam").

## Arbre de commandes

```
openclaw [--dev] [--profile <name>] <command>
  setup
  onboard
  configure
  config
    get
    set
    unset
  doctor
  security
    audit
  reset
  uninstall
  update
  channels
    list
    status
    logs
    add
    remove
    login
    logout
  skills
    list
    info
    check
  plugins
    list
    info
    install
    enable
    disable
    doctor
  memory
    status
    index
    search
  message
  agent
  agents
    list
    add
    delete
  acp
  status
  health
  sessions
  gateway
    call
    health
    status
    probe
    discover
    install
    uninstall
    start
    stop
    restart
    run
  logs
  system
    event
    heartbeat last|enable|disable
    presence
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
    auth add|setup-token|paste-token
    auth order get|set|clear
  sandbox
    list
    recreate
    explain
  cron
    status
    list
    add
    edit
    rm
    enable
    disable
    runs
    run
  nodes
  devices
  node
    run
    status
    install
    uninstall
    start
    stop
    restart
  approvals
    get
    set
    allowlist add|remove
  browser
    status
    start
    stop
    reset-profile
    tabs
    open
    focus
    close
    profiles
    create-profile
    delete-profile
    screenshot
    snapshot
    navigate
    resize
    click
    type
    press
    hover
    drag
    select
    upload
    fill
    dialog
    wait
    evaluate
    console
    pdf
  hooks
    list
    info
    check
    enable
    disable
    install
    update
  webhooks
    gmail setup|run
  pairing
    list
    approve
  docs
  dns
    setup
  tui
```

Note : les plugins peuvent ajouter des commandes de premier niveau supplémentaires (par exemple `openclaw voicecall`).

## Sécurité

- `openclaw security audit` — auditer config + état local pour les pièges de sécurité courants.
- `openclaw security audit --deep` — sonde live de Passerelle au meilleur effort.
- `openclaw security audit --fix` — resserrer les valeurs par défaut sûres et chmod état/config.

## Plugins

Gérer les extensions et leur config :

- `openclaw plugins list` — découvrir les plugins (utilisez `--json` pour la sortie machine).
- `openclaw plugins info <id>` — afficher les détails d'un plugin.
- `openclaw plugins install <path|.tgz|npm-spec>` — installer un plugin (ou ajouter un chemin de plugin à `plugins.load.paths`).
- `openclaw plugins enable <id>` / `disable <id>` — basculer `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — rapporter les erreurs de chargement de plugin.

La plupart des changements de plugin nécessitent un redémarrage de passerelle. Voir [/plugin](/fr-FR/tools/plugin).

## Mémoire

Recherche vectorielle sur `MEMORY.md` + `memory/*.md` :

- `openclaw memory status` — afficher les stats d'index.
- `openclaw memory index` — réindexer les fichiers mémoire.
- `openclaw memory search "<requête>"` — recherche sémantique sur la mémoire.

## Commandes slash de discussion

Les messages de discussion supportent les commandes `/...` (texte et native). Voir [/tools/slash-commands](/fr-FR/tools/slash-commands).

Points forts :

- `/status` pour diagnostics rapides.
- `/config` pour changements de config persistés.
- `/debug` pour remplacements de config runtime uniquement (mémoire, pas disque ; nécessite `commands.debug: true`).

## Configuration + intégration

### `setup`

Initialiser config + espace de travail.

Options :

- `--workspace <dir>` : chemin de l'espace de travail de l'agent (par défaut `~/.openclaw/workspace`).
- `--wizard` : exécuter l'assistant d'intégration.
- `--non-interactive` : exécuter l'assistant sans invites.
- `--mode <local|remote>` : mode assistant.
- `--remote-url <url>` : URL de Passerelle distante.
- `--remote-token <token>` : token de Passerelle distante.

L'assistant s'exécute automatiquement quand des drapeaux d'assistant sont présents (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Assistant interactif pour configurer passerelle, espace de travail et compétences.

Options :

- `--workspace <dir>`
- `--reset` (réinitialiser config + identifiants + sessions + espace de travail avant l'assistant)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual est un alias pour advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|custom-api-key|skip>`
- `--token-provider <id>` (non-interactif ; utilisé avec `--auth-choice token`)
- `--token <token>` (non-interactif ; utilisé avec `--auth-choice token`)
- `--token-profile-id <id>` (non-interactif ; par défaut : `<provider>:manual`)
- `--token-expires-in <duration>` (non-interactif ; ex. `365d`, `12h`)
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--custom-base-url <url>` (non-interactif ; utilisé avec `--auth-choice custom-api-key`)
- `--custom-model-id <id>` (non-interactif ; utilisé avec `--auth-choice custom-api-key`)
- `--custom-api-key <key>` (non-interactif ; optionnel ; utilisé avec `--auth-choice custom-api-key` ; se rabat sur `CUSTOM_API_KEY` quand omis)
- `--custom-provider-id <id>` (non-interactif ; id de fournisseur personnalisé optionnel)
- `--custom-compatibility <openai|anthropic>` (non-interactif ; optionnel ; par défaut `openai`)
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon` (alias : `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm recommandé ; bun non recommandé pour le runtime de Passerelle)
- `--json`

### `configure`

Assistant de configuration interactif (modèles, canaux, compétences, passerelle).

### `config`

Aides de config non-interactives (get/set/unset). Exécuter `openclaw config` sans sous-commande lance l'assistant.

Sous-commandes :

- `config get <path>` : afficher une valeur de config (chemin dot/bracket).
- `config set <path> <value>` : définir une valeur (JSON5 ou chaîne brute).
- `config unset <path>` : retirer une valeur.

### `doctor`

Vérifications de santé + corrections rapides (config + passerelle + services hérités).

Options :

- `--no-workspace-suggestions` : désactiver les conseils mémoire d'espace de travail.
- `--yes` : accepter les valeurs par défaut sans invite (sans tête).
- `--non-interactive` : ignorer les invites ; appliquer uniquement les migrations sûres.
- `--deep` : scanner les services système pour les installations de passerelle supplémentaires.

## Aides de canal

### `channels`

Gérer les comptes de canal de discussion (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams).

Sous-commandes :

- `channels list` : afficher les canaux configurés et profils d'auth.
- `channels status` : vérifier l'accessibilité de la passerelle et la santé du canal (`--probe` exécute des vérifications supplémentaires ; utilisez `openclaw health` ou `openclaw status --deep` pour les sondes de santé de passerelle).
- Astuce : `channels status` affiche des avertissements avec corrections suggérées quand il peut détecter des erreurs de configuration courantes (puis vous pointe vers `openclaw doctor`).
- `channels logs` : afficher les logs de canal récents du fichier log de passerelle.
- `channels add` : configuration de style assistant quand aucun drapeau n'est passé ; les drapeaux basculent en mode non-interactif.
- `channels remove` : désactiver par défaut ; passer `--delete` pour retirer les entrées de config sans invites.
- `channels login` : connexion de canal interactive (WhatsApp Web uniquement).
- `channels logout` : se déconnecter d'une session de canal (si supporté).

Options communes :

- `--channel <name>` : `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>` : id de compte de canal (par défaut `default`)
- `--name <label>` : nom d'affichage pour le compte

Options `channels login` :

- `--channel <channel>` (par défaut `whatsapp` ; supporte `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

Options `channels logout` :

- `--channel <channel>` (par défaut `whatsapp`)
- `--account <id>`

Options `channels list` :

- `--no-usage` : ignorer les instantanés d'utilisation/quota du fournisseur de modèle (OAuth/API-backed uniquement).
- `--json` : sortie JSON (inclut l'utilisation sauf si `--no-usage` est défini).

Options `channels logs` :

- `--channel <name|all>` (par défaut `all`)
- `--lines <n>` (par défaut `200`)
- `--json`

Plus de détails : [/concepts/oauth](/fr-FR/concepts/oauth)

Exemples :

```bash
openclaw channels add --channel telegram --account alerts --name "Bot Alertes" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Bot Travail" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Lister et inspecter les compétences disponibles plus infos de préparation.

Sous-commandes :

- `skills list` : lister les compétences (par défaut quand pas de sous-commande).
- `skills info <name>` : afficher les détails pour une compétence.
- `skills check` : résumé des compétences prêtes vs exigences manquantes.

Options :

- `--eligible` : afficher uniquement les compétences prêtes.
- `--json` : sortie JSON (pas de stylisation).
- `-v`, `--verbose` : inclure le détail des exigences manquantes.

Astuce : utilisez `npx clawhub` pour rechercher, installer et synchroniser les compétences.

### `pairing`

Approuver les demandes d'appairage DM à travers les canaux.

Sous-commandes :

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Configuration de hook Gmail Pub/Sub + exécuteur. Voir [/automation/gmail-pubsub](/fr-FR/automation/gmail-pubsub).

Sous-commandes :

- `webhooks gmail setup` (nécessite `--account <email>` ; supporte `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (remplacements runtime pour les mêmes drapeaux)

### `dns setup`

Aide DNS de découverte à grande échelle (CoreDNS + Tailscale). Voir [/gateway/discovery](/fr-FR/gateway/discovery).

Options :

- `--apply` : installer/mettre à jour la config CoreDNS (nécessite sudo ; macOS uniquement).

## Messagerie + agent

### `message`

Messagerie sortante unifiée + actions de canal.

Voir : [/cli/message](/fr-FR/cli/message)

Sous-commandes :

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Exemples :

- `openclaw message send --target +15555550123 --message "Salut"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Collation ?" --poll-option Pizza --poll-option Sushi`

### `agent`

Exécuter un tour d'agent via la Passerelle (ou `--local` intégré).

Requis :

- `--message <text>`

Options :

- `--to <dest>` (pour clé de session et livraison optionnelle)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (modèles GPT-5.2 + Codex uniquement)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Gérer les agents isolés (espaces de travail + auth + routage).

#### `agents list`

Lister les agents configurés.

Options :

- `--json`
- `--bindings`

#### `agents add [name]`

Ajouter un nouvel agent isolé. Exécute l'assistant guidé sauf si des drapeaux (ou `--non-interactive`) sont passés ; `--workspace` est requis en mode non-interactif.

Options :

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (répétable)
- `--non-interactive`
- `--json`

Les spécifications de liaison utilisent `channel[:accountId]`. Quand `accountId` est omis pour WhatsApp, l'id de compte par défaut est utilisé.

#### `agents delete <id>`

Supprimer un agent et élaguer son espace de travail + état.

Options :

- `--force`
- `--json`

### `acp`

Exécuter le pont ACP qui connecte les IDE à la Passerelle.

Voir [`acp`](/fr-FR/cli/acp) pour les options complètes et exemples.

### `status`

Afficher la santé de session liée et destinataires récents.

Options :

- `--json`
- `--all` (diagnostic complet ; lecture seule, collable)
- `--deep` (sonder les canaux)
- `--usage` (afficher l'utilisation/quota du fournisseur de modèle)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias pour `--verbose`)

Notes :

- L'aperçu inclut le statut du service hôte de Passerelle + nœud quand disponible.

### Suivi d'utilisation

OpenClaw peut afficher l'utilisation/quota du fournisseur quand des identifiants OAuth/API sont disponibles.

Surfaces :

- `/status` (ajoute une courte ligne d'utilisation du fournisseur quand disponible)
- `openclaw status --usage` (affiche la répartition complète du fournisseur)
- Barre de menu macOS (section Utilisation sous Contexte)

Notes :

- Les données viennent directement des points de terminaison d'utilisation du fournisseur (pas d'estimations).
- Fournisseurs : Anthropic, GitHub Copilot, OpenAI Codex OAuth, plus Gemini CLI/Antigravity quand ces plugins de fournisseur sont activés.
- Si aucun identifiant correspondant n'existe, l'utilisation est cachée.
- Détails : voir [Suivi d'utilisation](/fr-FR/concepts/usage-tracking).

### `health`

Récupérer la santé de la Passerelle en cours d'exécution.

Options :

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Lister les sessions de conversation stockées.

Options :

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Réinitialiser / Désinstaller

### `reset`

Réinitialiser config/état local (garde le CLI installé).

Options :

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notes :

- `--non-interactive` nécessite `--scope` et `--yes`.

### `uninstall`

Désinstaller le service de passerelle + données locales (le CLI reste).

Options :

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notes :

- `--non-interactive` nécessite `--yes` et portées explicites (ou `--all`).

## Passerelle

### `gateway`

Exécuter la Passerelle WebSocket.

Options :

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (réinitialiser config dev + identifiants + sessions + espace de travail)
- `--force` (tuer le listener existant sur le port)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias pour `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Gérer le service de Passerelle (launchd/systemd/schtasks).

Sous-commandes :

- `gateway status` (sonde le RPC de Passerelle par défaut)
- `gateway install` (installation de service)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Notes :

- `gateway status` sonde le RPC de Passerelle par défaut en utilisant le port/config résolu du service (remplacer avec `--url/--token/--password`).
- `gateway status` supporte `--no-probe`, `--deep` et `--json` pour le scripting.
- `gateway status` affiche également les services de passerelle hérités ou supplémentaires quand il peut les détecter (`--deep` ajoute des scans au niveau système). Les services OpenClaw nommés par profil sont traités comme de première classe et ne sont pas signalés comme "extra".
- `gateway status` affiche quel chemin de config le CLI utilise vs quelle config le service utilise probablement (env du service), plus l'URL de cible de sonde résolue.
- `gateway install|uninstall|start|stop|restart` supportent `--json` pour le scripting (la sortie par défaut reste conviviale).
- `gateway install` par défaut sur le runtime Node ; bun n'est **pas recommandé** (bugs WhatsApp/Telegram).
- Options `gateway install` : `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Suivre les logs de fichier de Passerelle via RPC.

Notes :

- Les sessions TTY affichent une vue colorée et structurée ; non-TTY revient au texte brut.
- `--json` émet du JSON délimité par ligne (un événement log par ligne).

Exemples :

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Aides CLI de Passerelle (utilisez `--url`, `--token`, `--password`, `--timeout`, `--expect-final` pour les sous-commandes RPC).
Quand vous passez `--url`, le CLI n'applique pas automatiquement les identifiants de config ou d'environnement.
Incluez `--token` ou `--password` explicitement. L'absence d'identifiants explicites est une erreur.

Sous-commandes :

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

RPC courants :

- `config.apply` (valider + écrire config + redémarrer + réveiller)
- `config.patch` (fusionner une mise à jour partielle + redémarrer + réveiller)
- `update.run` (exécuter mise à jour + redémarrer + réveiller)

Astuce : quand vous appelez `config.set`/`config.apply`/`config.patch` directement, passez `baseHash` de `config.get` si une config existe déjà.

## Modèles

Voir [/concepts/models](/fr-FR/concepts/models) pour le comportement de secours et stratégie de scan.

Auth Anthropic préférée (setup-token) :

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (racine)

`openclaw models` est un alias pour `models status`.

Options racine :

- `--status-json` (alias pour `models status --json`)
- `--status-plain` (alias pour `models status --plain`)

### `models list`

Options :

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Options :

- `--json`
- `--plain`
- `--check` (sortie 1=expiré/manquant, 2=expirant)
- `--probe` (sonde live des profils d'auth configurés)
- `--probe-provider <name>`
- `--probe-profile <id>` (répéter ou séparé par virgule)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Inclut toujours l'aperçu d'auth et le statut d'expiration OAuth pour les profils dans le magasin d'auth.
`--probe` exécute des requêtes live (peut consommer des tokens et déclencher des limites de taux).

### `models set <model>`

Définir `agents.defaults.model.primary`.

### `models set-image <model>`

Définir `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

Options :

- `list` : `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Options :

- `list` : `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Options :

- `list` : `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Options :

- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>`
- `--concurrency <n>`
- `--no-probe`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

### `models auth add|setup-token|paste-token`

Options :

- `add` : aide d'auth interactive
- `setup-token` : `--provider <name>` (par défaut `anthropic`), `--yes`
- `paste-token` : `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Options :

- `get` : `--provider <name>`, `--agent <id>`, `--json`
- `set` : `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear` : `--provider <name>`, `--agent <id>`

## Système

### `system event`

Mettre en file d'attente un événement système et optionnellement déclencher un heartbeat (RPC Passerelle).

Requis :

- `--text <text>`

Options :

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Contrôles de heartbeat (RPC Passerelle).

Options :

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Lister les entrées de présence système (RPC Passerelle).

Options :

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Gérer les tâches planifiées (RPC Passerelle). Voir [/automation/cron-jobs](/fr-FR/automation/cron-jobs).

Sous-commandes :

- `cron status [--json]`
- `cron list [--all] [--json]` (sortie tableau par défaut ; utilisez `--json` pour brut)
- `cron add` (alias : `create` ; nécessite `--name` et exactement un de `--at` | `--every` | `--cron`, et exactement une charge utile de `--system-event` | `--message`)
- `cron edit <id>` (patcher des champs)
- `cron rm <id>` (alias : `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Toutes les commandes `cron` acceptent `--url`, `--token`, `--timeout`, `--expect-final`.

## Hôte de nœud

`node` exécute un **hôte de nœud sans tête** ou le gère comme service d'arrière-plan. Voir [`openclaw node`](/fr-FR/cli/node).

Sous-commandes :

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nœuds

`nodes` communique avec la Passerelle et cible les nœuds appairés. Voir [/nodes](/fr-FR/nodes).

Options communes :

- `--url`, `--token`, `--timeout`, `--json`

Sous-commandes :

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (nœud mac ou hôte de nœud sans tête)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (mac uniquement)

Caméra :

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + écran :

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Localisation :

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Navigateur

CLI de contrôle de navigateur (Chrome/Brave/Edge/Chromium dédié). Voir [`openclaw browser`](/fr-FR/cli/browser) et l'[Outil Navigateur](/fr-FR/tools/browser).

Options communes :

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Gérer :

- `browser status`
- `browser start`
- `browser stop`
- `browser reset-profile`
- `browser tabs`
- `browser open <url>`
- `browser focus <targetId>`
- `browser close [targetId]`
- `browser profiles`
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`
- `browser delete-profile --name <name>`

Inspecter :

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Actions :

- `browser navigate <url> [--target-id <id>]`
- `browser resize <width> <height> [--target-id <id>]`
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`
- `browser press <key> [--target-id <id>]`
- `browser hover <ref> [--target-id <id>]`
- `browser drag <startRef> <endRef> [--target-id <id>]`
- `browser select <ref> <values...> [--target-id <id>]`
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`
- `browser console [--level <error|warn|info>] [--target-id <id>]`
- `browser pdf [--target-id <id>]`

## Recherche de docs

### `docs [query...]`

Rechercher dans l'index docs live.

## TUI

### `tui`

Ouvrir l'UI terminal connectée à la Passerelle.

Options :

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (par défaut `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
