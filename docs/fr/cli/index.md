---
summary: "Reference de la CLI OpenClaw pour les commandes, sous-commandes et options `openclaw`"
read_when:
  - Ajout ou modification de commandes ou d’options CLI
  - Documentation de nouvelles surfaces de commandes
title: "Reference CLI"
---

# Reference CLI

Cette page decrit le comportement actuel de la CLI. Si les commandes changent, mettez a jour ce document.

## Pages de commandes

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`reset`](/cli/reset)
- [`uninstall`](/cli/uninstall)
- [`update`](/cli/update)
- [`message`](/cli/message)
- [`agent`](/cli/agent)
- [`agents`](/cli/agents)
- [`acp`](/cli/acp)
- [`status`](/cli/status)
- [`health`](/cli/health)
- [`sessions`](/cli/sessions)
- [`gateway`](/cli/gateway)
- [`logs`](/cli/logs)
- [`system`](/cli/system)
- [`models`](/cli/models)
- [`memory`](/cli/memory)
- [`nodes`](/cli/nodes)
- [`devices`](/cli/devices)
- [`node`](/cli/node)
- [`approvals`](/cli/approvals)
- [`sandbox`](/cli/sandbox)
- [`tui`](/cli/tui)
- [`browser`](/cli/browser)
- [`cron`](/cli/cron)
- [`dns`](/cli/dns)
- [`docs`](/cli/docs)
- [`hooks`](/cli/hooks)
- [`webhooks`](/cli/webhooks)
- [`pairing`](/cli/pairing)
- [`plugins`](/cli/plugins) (commandes de plugins)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (plugin ; si installe)

## Indicateurs globaux

- `--dev` : isole l’etat sous `~/.openclaw-dev` et decale les ports par defaut.
- `--profile <name>` : isole l’etat sous `~/.openclaw-<name>`.
- `--no-color` : desactive les couleurs ANSI.
- `--update` : raccourci pour `openclaw update` (installations depuis les sources uniquement).
- `-V`, `--version`, `-v` : affiche la version et quitte.

## Style de sortie

- Les couleurs ANSI et les indicateurs de progression ne s’affichent que dans les sessions TTY.
- Les hyperliens OSC-8 s’affichent comme des liens cliquables dans les terminaux pris en charge ; sinon, repli vers des URL en clair.
- `--json` (et `--plain` le cas echeant) desactive le style pour une sortie propre.
- `--no-color` desactive le style ANSI ; `NO_COLOR=1` est egalement respecte.
- Les commandes longues affichent un indicateur de progression (OSC 9;4 lorsqu’il est pris en charge).

## Palette de couleurs

OpenClaw utilise une palette « lobster » pour la sortie CLI.

- `accent` (#FF5A2D) : titres, etiquettes, mises en evidence principales.
- `accentBright` (#FF7A3D) : noms de commandes, emphase.
- `accentDim` (#D14A22) : texte de mise en evidence secondaire.
- `info` (#FF8A5B) : valeurs informatives.
- `success` (#2FBF71) : etats de succes.
- `warn` (#FFB020) : avertissements, replis, attention.
- `error` (#E23D2D) : erreurs, echecs.
- `muted` (#8B7F77) : attenuation, metadonnees.

Source de verite de la palette : `src/terminal/palette.ts` (alias « lobster seam »).

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

Remarque : les plugins peuvent ajouter des commandes de premier niveau supplementaires (par exemple `openclaw voicecall`).

## Securite

- `openclaw security audit` — audit de la configuration et de l’etat local pour les erreurs de securite courantes.
- `openclaw security audit --deep` — sonde en direct du Gateway (passerelle) avec effort maximal.
- `openclaw security audit --fix` — renforce les valeurs par defaut sures et applique chmod a l’etat/la configuration.

## Plugins

Gererez les extensions et leur configuration :

- `openclaw plugins list` — decouvrir des plugins (utilisez `--json` pour une sortie machine).
- `openclaw plugins info <id>` — afficher les details d’un plugin.
- `openclaw plugins install <path|.tgz|npm-spec>` — installer un plugin (ou ajouter un chemin de plugin a `plugins.load.paths`).
- `openclaw plugins enable <id>` / `disable <id>` — activer/desactiver `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — signaler les erreurs de chargement des plugins.

La plupart des modifications de plugins necessitent un redemarrage du Gateway. Voir [/plugin](/plugin).

## Memoire

Recherche vectorielle sur `MEMORY.md` + `memory/*.md` :

- `openclaw memory status` — afficher les statistiques de l’index.
- `openclaw memory index` — reindexer les fichiers de memoire.
- `openclaw memory search "<query>"` — recherche semantique dans la memoire.

## Commandes slash de chat

Les messages de chat prennent en charge les commandes `/...` (texte et natives). Voir [/tools/slash-commands](/tools/slash-commands).

Points forts :

- `/status` pour des diagnostics rapides.
- `/config` pour des modifications de configuration persistantes.
- `/debug` pour des surcharges de configuration uniquement a l’execution (memoire, pas disque ; necessite `commands.debug: true`).

## Configuration + prise en main

### `setup`

Initialiser la configuration et l’espace de travail.

Options :

- `--workspace <dir>` : chemin de l’espace de travail de l’agent (par defaut `~/.openclaw/workspace`).
- `--wizard` : lancer l’assistant de prise en main.
- `--non-interactive` : lancer l’assistant sans invites.
- `--mode <local|remote>` : mode de l’assistant.
- `--remote-url <url>` : URL distante du Gateway.
- `--remote-token <token>` : jeton du Gateway distant.

L’assistant s’execute automatiquement lorsque des indicateurs d’assistant sont presents (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Assistant interactif pour configurer le gateway, l’espace de travail et les skills.

Options :

- `--workspace <dir>`
- `--reset` (reinitialise configuration + informations d’identification + sessions + espace de travail avant l’assistant)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual est un alias de advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (non interactif ; utilise avec `--auth-choice token`)
- `--token <token>` (non interactif ; utilise avec `--auth-choice token`)
- `--token-profile-id <id>` (non interactif ; par defaut : `<provider>:manual`)
- `--token-expires-in <duration>` (non interactif ; ex. `365d`, `12h`)
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
- `--node-manager <npm|pnpm|bun>` (pnpm recommande ; bun non recommande pour l’execution du Gateway)
- `--json`

### `configure`

Assistant interactif de configuration (modeles, canaux, skills, gateway).

### `config`

Aides de configuration non interactives (get/set/unset). L’execution de `openclaw config` sans
sous-commande lance l’assistant.

Sous-commandes :

- `config get <path>` : afficher une valeur de configuration (chemin point/crochets).
- `config set <path> <value>` : definir une valeur (JSON5 ou chaine brute).
- `config unset <path>` : supprimer une valeur.

### `doctor`

Verifications d’etat + corrections rapides (configuration + gateway + services herites).

Options :

- `--no-workspace-suggestions` : desactiver les indications de memoire de l’espace de travail.
- `--yes` : accepter les valeurs par defaut sans invites (sans interface).
- `--non-interactive` : ignorer les invites ; appliquer uniquement les migrations sures.
- `--deep` : analyser les services systeme pour des installations supplementaires du gateway.

## Aides pour les canaux

### `channels`

Gerer les comptes de canaux de chat (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/Microsoft Teams).

Sous-commandes :

- `channels list` : afficher les canaux configures et les profils d’authentification.
- `channels status` : verifier l’accessibilite du gateway et l’etat des canaux (`--probe` effectue des verifications supplementaires ; utilisez `openclaw health` ou `openclaw status --deep` pour les sondes d’etat du gateway).
- Astuce : `channels status` affiche des avertissements avec des correctifs suggeres lorsqu’il peut detecter des erreurs de configuration courantes (puis vous dirige vers `openclaw doctor`).
- `channels logs` : afficher les journaux recents des canaux depuis le fichier de log du gateway.
- `channels add` : configuration de type assistant lorsque aucun indicateur n’est fourni ; les indicateurs basculent en mode non interactif.
- `channels remove` : desactive par defaut ; passez `--delete` pour supprimer les entrees de configuration sans invites.
- `channels login` : connexion interactive a un canal (WhatsApp Web uniquement).
- `channels logout` : se deconnecter d’une session de canal (si pris en charge).

Options courantes :

- `--channel <name>` : `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>` : identifiant du compte de canal (par defaut `default`)
- `--name <label>` : nom d’affichage du compte

Options de `channels login` :

- `--channel <channel>` (par defaut `whatsapp` ; prend en charge `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

Options de `channels logout` :

- `--channel <channel>` (par defaut `whatsapp`)
- `--account <id>`

Options de `channels list` :

- `--no-usage` : ignorer les instantanes d’utilisation/quota du fournisseur de modeles (OAuth/API uniquement).
- `--json` : sortie JSON (inclut l’utilisation sauf si `--no-usage` est defini).

Options de `channels logs` :

- `--channel <name|all>` (par defaut `all`)
- `--lines <n>` (par defaut `200`)
- `--json`

Plus de details : [/concepts/oauth](/concepts/oauth)

Exemples :

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Lister et inspecter les skills disponibles ainsi que les informations de preparation.

Sous-commandes :

- `skills list` : lister les skills (par defaut lorsque aucune sous-commande).
- `skills info <name>` : afficher les details d’un skill.
- `skills check` : resume des prets vs exigences manquantes.

Options :

- `--eligible` : afficher uniquement les skills prets.
- `--json` : sortie JSON (sans style).
- `-v`, `--verbose` : inclure le detail des exigences manquantes.

Astuce : utilisez `npx clawhub` pour rechercher, installer et synchroniser des skills.

### `pairing`

Approuver les demandes d'appairage de DM à travers les canaux.

Sous-commandes :

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Configuration et execution du hook Gmail Pub/Sub. Voir [/automation/gmail-pubsub](/automation/gmail-pubsub).

Sous-commandes :

- `webhooks gmail setup` (necessite `--account <email>` ; prend en charge `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (surcharges a l’execution pour les memes indicateurs)

### `dns setup`

Assistant DNS de decouverte a grande echelle (CoreDNS + Tailscale). Voir [/gateway/discovery](/gateway/discovery).

Options :

- `--apply` : installer/mettre a jour la configuration CoreDNS (necessite sudo ; macOS uniquement).

## Messagerie + agent

### `message`

Messagerie sortante unifiee + actions de canal.

Voir : [/cli/message](/cli/message)

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

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Executer un tour d’agent via le Gateway (ou `--local` integre).

Requis :

- `--message <text>`

Options :

- `--to <dest>` (pour la cle de session et la livraison optionnelle)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (modeles GPT-5.2 + Codex uniquement)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Gerer les agents isoles (espaces de travail + authentification + routage).

#### `agents list`

Lister les agents configures.

Options :

- `--json`
- `--bindings`

#### `agents add [name]`

Ajouter un nouvel agent isole. Execute l’assistant guide sauf si des indicateurs (ou `--non-interactive`) sont fournis ; `--workspace` est requis en mode non interactif.

Options :

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (repetable)
- `--non-interactive`
- `--json`

Les specifications de liaison utilisent `channel[:accountId]`. Lorsque `accountId` est omis pour WhatsApp, l’identifiant de compte par defaut est utilise.

#### `agents delete <id>`

Supprimer un agent et purger son espace de travail et son etat.

Options :

- `--force`
- `--json`

### `acp`

Executer le pont ACP qui connecte les IDE au Gateway.

Voir [`acp`](/cli/acp) pour les options completes et des exemples.

### `status`

Afficher l’etat des sessions liees et les destinataires recents.

Options :

- `--json`
- `--all` (diagnostic complet ; lecture seule, copiable)
- `--deep` (sonder les canaux)
- `--usage` (afficher l’utilisation/quota du fournisseur de modeles)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias de `--verbose`)

Notes :

- La vue d’ensemble inclut l’etat du Gateway et du service hote de noeud lorsque disponible.

### Suivi de l’utilisation

OpenClaw peut afficher l’utilisation/le quota des fournisseurs lorsque des informations d’identification OAuth/API sont disponibles.

Surfaces :

- `/status` (ajoute une courte ligne d’utilisation du fournisseur lorsque disponible)
- `openclaw status --usage` (affiche la repartition complete par fournisseur)
- Barre de menu macOS (section Utilisation sous Contexte)

Notes :

- Les donnees proviennent directement des points d’extremite d’utilisation des fournisseurs (sans estimations).
- Fournisseurs : Anthropic, GitHub Copilot, OpenAI Codex OAuth, ainsi que Gemini CLI/Antigravity lorsque ces plugins de fournisseur sont actives.
- En l’absence d’informations d’identification correspondantes, l’utilisation est masquee.
- Details : voir [Usage tracking](/concepts/usage-tracking).

### `health`

Recupere l'etat de sante de la Gateway (passerelle) en cours d'execution.

Options :

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Lister les sessions de conversation stockees.

Options :

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Reinitialisation / Desinstallation

### `reset`

Reinitialiser la configuration et l’etat locaux (la CLI reste installee).

Options :

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notes :

- `--non-interactive` necessite `--scope` et `--yes`.

### `uninstall`

Desinstaller le service gateway et les donnees locales (la CLI reste).

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

- `--non-interactive` necessite `--yes` et des portees explicites (ou `--all`).

## Gateway

### `gateway`

Executer le Gateway WebSocket.

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
- `--reset` (reinitialise la configuration de developpement + informations d’identification + sessions + espace de travail)
- `--force` (arrete l’ecouteur existant sur le port)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias de `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Gerer le service Gateway (launchd/systemd/schtasks).

Sous-commandes :

- `gateway status` (sonde la RPC du Gateway par defaut)
- `gateway install` (installation du service)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Notes :

- `gateway status` sonde la RPC du Gateway par defaut en utilisant le port/la configuration resolus du service (surcharge avec `--url/--token/--password`).
- `gateway status` prend en charge `--no-probe`, `--deep` et `--json` pour le scripting.
- `gateway status` expose egalement les services gateway herites ou supplementaires lorsqu’il peut les detecter (`--deep` ajoute des analyses au niveau systeme). Les services OpenClaw nommes par profil sont traites comme de premiere classe et ne sont pas signales comme « supplementaires ».
- `gateway status` affiche le chemin de configuration utilise par la CLI par rapport a celui probablement utilise par le service (env du service), ainsi que l’URL cible de la sonde resolue.
- `gateway install|uninstall|start|stop|restart` prend en charge `--json` pour le scripting (la sortie par defaut reste conviviale).
- `gateway install` utilise par defaut le runtime Node ; bun **n’est pas recommande** (bogues WhatsApp/Telegram).
- Options de `gateway install` : `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Suivre les journaux de fichiers du Gateway via RPC.

Notes :

- Les sessions TTY affichent une vue structuree et colorisee ; les sessions non TTY reviennent au texte brut.
- `--json` emet du JSON delimite par lignes (un evenement de journal par ligne).

Exemples :

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Aides CLI du Gateway (utilisez `--url`, `--token`, `--password`, `--timeout`, `--expect-final` pour les sous-commandes RPC).
Lorsque vous passez `--url`, la CLI n’applique pas automatiquement la configuration ni les informations d’identification de l’environnement.
Incluez explicitement `--token` ou `--password`. L’absence d’informations d’identification explicites est une erreur.

Sous-commandes :

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

RPC courantes :

- `config.apply` (valider + ecrire la configuration + redemarrer + reveiller)
- `config.patch` (fusionner une mise a jour partielle + redemarrer + reveiller)
- `update.run` (executer la mise a jour + redemarrer + reveiller)

Astuce : lors de l’appel direct de `config.set`/`config.apply`/`config.patch`, passez `baseHash` depuis
`config.get` si une configuration existe deja.

## Modeles

Voir [/concepts/models](/concepts/models) pour le comportement de repli et la strategie d’analyse.

Authentification Anthropic preferee (setup-token) :

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (racine)

`openclaw models` est un alias de `models status`.

Options racine :

- `--status-json` (alias de `models status --json`)
- `--status-plain` (alias de `models status --plain`)

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
- `--check` (sortie 1 = expire/manquant, 2 = expirant)
- `--probe` (sonde en direct des profils d’authentification configures)
- `--probe-provider <name>`
- `--probe-profile <id>` (repetable ou separe par des virgules)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Inclut toujours la vue d’ensemble de l’authentification et l’etat d’expiration OAuth pour les profils du magasin d’authentification.
`--probe` execute des requetes en direct (peut consommer des jetons et declencher des limites de debit).

### `models set <model>`

Definir `agents.defaults.model.primary`.

### `models set-image <model>`

Definir `agents.defaults.imageModel.primary`.

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

- `add` : assistant d’authentification interactif
- `setup-token` : `--provider <name>` (par defaut `anthropic`), `--yes`
- `paste-token` : `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Options :

- `get` : `--provider <name>`, `--agent <id>`, `--json`
- `set` : `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear` : `--provider <name>`, `--agent <id>`

## Systeme

### `system event`

Mettre en file d’attente un evenement systeme et declencher optionnellement un battement (RPC du Gateway).

Requis :

- `--text <text>`

Options :

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Commandes de battement (RPC du Gateway).

Options :

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Lister les entrees de presence systeme (RPC du Gateway).

Options :

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Gerer les taches planifiees (RPC du Gateway). Voir [/automation/cron-jobs](/automation/cron-jobs).

Sous-commandes :

- `cron status [--json]`
- `cron list [--all] [--json]` (sortie tabulaire par defaut ; utilisez `--json` pour le brut)
- `cron add` (alias : `create` ; necessite `--name` et exactement un de `--at` | `--every` | `--cron`, et exactement une charge utile de `--system-event` | `--message`)
- `cron edit <id>` (modifier des champs)
- `cron rm <id>` (alias : `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Toutes les commandes `cron` acceptent `--url`, `--token`, `--timeout`, `--expect-final`.

## Hôte du noeud

`node` execute un **hote de noeud sans interface** ou le gere comme un service en arriere-plan. Voir
[`openclaw node`](/cli/node).

Sous-commandes :

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Noeuds

`nodes` communique avec le Gateway et cible les noeuds appaires. Voir [/nodes](/nodes).

Options courantes :

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
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (noeud mac ou hote de noeud sans interface)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (mac uniquement)

Camera :

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + ecran :

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

CLI de controle du navigateur (Chrome/Brave/Edge/Chromium dedies). Voir [`openclaw browser`](/cli/browser) et l’[outil Navigateur](/tools/browser).

Options courantes :

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Gestion :

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

Inspection :

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

## Recherche dans la documentation

### `docs [query...]`

Rechercher dans l’index de documentation en direct.

## TUI

### `tui`

Ouvrir l’interface utilisateur terminal connectee au Gateway.

Options :

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (par defaut `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
