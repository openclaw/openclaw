---
summary: "Commandes slash : texte vs natives, configuration et commandes prises en charge"
read_when:
  - Utilisation ou configuration des commandes de chat
  - Debogage du routage des commandes ou des autorisations
title: "Commandes slash"
---

# Commandes slash

Les commandes sont gérées par la Gateway (passerelle). La plupart des commandes doivent etre envoyees comme un message **autonome** qui commence par `/`.
La commande de chat bash reservee a l’hote utilise `! <cmd>` (avec `/bash <cmd>` comme alias).

Il existe deux systemes connexes :

- **Commandes** : messages `/...` autonomes.
- **Directives** : `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Les directives sont supprimees du message avant que le modele ne le voie.
  - Dans les messages de chat normaux (non constitues uniquement de directives), elles sont traitees comme des « indices inline » et **ne** persistent **pas** les parametres de session.
  - Dans les messages uniquement constitues de directives (le message ne contient que des directives), elles persistent dans la session et renvoient un accusé de reception.
  - Les directives ne sont appliquees que pour les **expediteurs autorises** (listes d’autorisation de canal / appairage plus `commands.useAccessGroups`).
    Les expediteurs non autorises voient les directives traitees comme du texte brut.

Il existe egalement quelques **raccourcis inline** (expediteurs autorises uniquement) : `/help`, `/commands`, `/status`, `/whoami` (`/id`).
Ils s’executent immediatement, sont supprimes avant que le modele ne voie le message, et le texte restant poursuit le flux normal.

## Configuration

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (par defaut `true`) active l’analyse des `/...` dans les messages de chat.
  - Sur les surfaces sans commandes natives (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), les commandes texte fonctionnent toujours meme si vous reglez cette option sur `false`.
- `commands.native` (par defaut `"auto"`) enregistre les commandes natives.
  - Auto : active pour Discord/Telegram ; desactive pour Slack (jusqu’a l’ajout de commandes slash) ; ignore pour les fournisseurs sans prise en charge native.
  - Definissez `channels.discord.commands.native`, `channels.telegram.commands.native` ou `channels.slack.commands.native` pour surcharger par fournisseur (bool ou `"auto"`).
  - `false` efface les commandes precedemment enregistrees sur Discord/Telegram au demarrage. Les commandes Slack sont gerees dans l’application Slack et ne sont pas supprimees automatiquement.
- `commands.nativeSkills` (par defaut `"auto"`) enregistre nativement les commandes de **skill** lorsque c’est pris en charge.
  - Auto : active pour Discord/Telegram ; desactive pour Slack (Slack exige la creation d’une commande slash par skill).
  - Definissez `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` ou `channels.slack.commands.nativeSkills` pour surcharger par fournisseur (bool ou `"auto"`).
- `commands.bash` (par defaut `false`) autorise `! <cmd>` a executer des commandes shell de l’hote (`/bash <cmd>` est un alias ; necessite les listes d’autorisation `tools.elevated`).
- `commands.bashForegroundMs` (par defaut `2000`) controle le delai d’attente de bash avant le passage en mode arriere-plan (`0` passe immediatement en arriere-plan).
- `commands.config` (par defaut `false`) active `/config` (lecture/ecriture de `openclaw.json`).
- `commands.debug` (par defaut `false`) active `/debug` (surcharges a l’execution uniquement).
- `commands.useAccessGroups` (par defaut `true`) impose des listes d’autorisation/politiques pour les commandes.

## Liste des commandes

Texte + natives (lorsqu’activees) :

- `/help`
- `/commands`
- `/skill <name> [input]` (executer une skill par nom)
- `/status` (afficher l’etat actuel ; inclut l’utilisation/le quota du fournisseur pour le fournisseur de modele courant lorsque disponible)
- `/allowlist` (lister/ajouter/supprimer des entrees de liste d’autorisation)
- `/approve <id> allow-once|allow-always|deny` (resoudre les invites d’approbation d’execution)
- `/context [list|detail|json]` (expliquer le « contexte » ; `detail` affiche la taille par fichier + par outil + par skill + du prompt systeme)
- `/whoami` (afficher votre identifiant d’expediteur ; alias : `/id`)
- `/subagents list|stop|log|info|send` (inspecter, arreter, journaliser ou envoyer des messages aux executions de sous-agents pour la session courante)
- `/config show|get|set|unset` (persister la configuration sur disque, reserve au proprietaire ; necessite `commands.config: true`)
- `/debug show|set|unset|reset` (surcharges a l’execution, reserve au proprietaire ; necessite `commands.debug: true`)
- `/usage off|tokens|full|cost` (pied de page d’utilisation par reponse ou resume des couts locaux)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (controle du TTS ; voir [/tts](/tts))
  - Discord : la commande native est `/voice` (Discord reserve `/tts`) ; le texte `/tts` fonctionne toujours.
- `/stop`
- `/restart`
- `/dock-telegram` (alias : `/dock_telegram`) (basculer les reponses vers Telegram)
- `/dock-discord` (alias : `/dock_discord`) (basculer les reponses vers Discord)
- `/dock-slack` (alias : `/dock_slack`) (basculer les reponses vers Slack)
- `/activation mention|always` (groupes uniquement)
- `/send on|off|inherit` (reserve au proprietaire)
- `/reset` ou `/new [model]` (indice de modele optionnel ; le reste est transmis tel quel)
- `/think <off|minimal|low|medium|high|xhigh>` (choix dynamiques selon le modele/fournisseur ; alias : `/thinking`, `/t`)
- `/verbose on|full|off` (alias : `/v`)
- `/reasoning on|off|stream` (alias : `/reason` ; lorsqu’active, envoie un message separe prefixe `Reasoning:` ; `stream` = brouillon Telegram uniquement)
- `/elevated on|off|ask|full` (alias : `/elev` ; `full` ignore les approbations d’execution)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (envoyez `/exec` pour afficher l’etat actuel)
- `/model <name>` (alias : `/models` ; ou `/<alias>` depuis `agents.defaults.models.*.alias`)
- `/queue <mode>` (plus des options comme `debounce:2s cap:25 drop:summarize` ; envoyez `/queue` pour voir les parametres actuels)
- `/bash <command>` (reserve a l’hote ; alias de `! <command>` ; necessite les listes d’autorisation `commands.bash: true` + `tools.elevated`)

Texte uniquement :

- `/compact [instructions]` (voir [/concepts/compaction](/concepts/compaction))
- `! <command>` (reserve a l’hote ; une a la fois ; utilisez `!poll` + `!stop` pour les travaux de longue duree)
- `!poll` (verifier la sortie / l’etat ; accepte l’option `sessionId` ; `/bash poll` fonctionne aussi)
- `!stop` (arreter le job bash en cours ; accepte l’option `sessionId` ; `/bash stop` fonctionne aussi)

Remarques :

- Les commandes acceptent un `:` optionnel entre la commande et les arguments (par ex. `/think: high`, `/send: on`, `/help:`).
- `/new <model>` accepte un alias de modele, `provider/model`, ou un nom de fournisseur (correspondance approximative) ; en l’absence de correspondance, le texte est traite comme le corps du message.
- Pour le detail complet de l’utilisation par fournisseur, utilisez `openclaw status --usage`.
- `/allowlist add|remove` necessite `commands.config=true` et respecte les `configWrites` du canal.
- `/usage` controle le pied de page d’utilisation par reponse ; `/usage cost` affiche un resume des couts locaux a partir des journaux de session OpenClaw.
- `/restart` est desactive par defaut ; definissez `commands.restart: true` pour l’activer.
- `/verbose` est destine au debogage et a une visibilite accrue ; laissez-le **desactive** en usage normal.
- `/reasoning` (et `/verbose`) sont risques dans les contextes de groupe : ils peuvent reveler un raisonnement interne ou des sorties d’outils que vous ne souhaitiez pas exposer. Preferez les laisser desactives, surtout dans les discussions de groupe.
- **Voie rapide :** les messages constitues uniquement de commandes provenant d’expediteurs autorises sont traites immediatement (contournent la file + le modele).
- **Contournement des mentions en groupe :** les messages uniquement commandes provenant d’expediteurs autorises contournent les exigences de mention.
- **Raccourcis inline (expediteurs autorises uniquement) :** certaines commandes fonctionnent aussi lorsqu’elles sont integrees dans un message normal et sont supprimees avant que le modele ne voie le texte restant.
  - Exemple : `hey /status` declenche une reponse d’etat, et le texte restant poursuit le flux normal.
- Actuellement : `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Les messages uniquement commandes non autorises sont ignores silencieusement, et les jetons inline `/...` sont traites comme du texte brut.
- **Commandes de skill :** les skills `user-invocable` sont exposees comme commandes slash. Les noms sont assainis en `a-z0-9_` (32 caracteres max) ; les collisions recoivent des suffixes numeriques (par ex. `_2`).
  - `/skill <name> [input]` execute une skill par nom (utile lorsque les limites de commandes natives empechent les commandes par skill).
  - Par defaut, les commandes de skill sont transmises au modele comme une requete normale.
  - Les skills peuvent declarer optionnellement `command-dispatch: tool` pour router la commande directement vers un outil (deterministe, sans modele).
  - Exemple : `/prose` (plugin OpenProse) — voir [OpenProse](/prose).
- **Arguments des commandes natives :** Discord utilise l’autocompletion pour les options dynamiques (et des menus de boutons lorsque vous omettez des arguments requis). Telegram et Slack affichent un menu de boutons lorsqu’une commande prend en charge des choix et que vous omettez l’argument.

## Surfaces d’utilisation (quoi s’affiche ou)

- **Utilisation/quota du fournisseur** (exemple : « Claude 80% restant ») s’affiche dans `/status` pour le fournisseur de modele courant lorsque le suivi d’utilisation est active.
- **Jetons/cout par reponse** est controle par `/usage off|tokens|full` (ajoute aux reponses normales).
- `/model status` concerne les **modeles/auth/endpoints**, pas l’utilisation.

## Selection du modele (`/model`)

`/model` est implemente comme une directive.

Exemples :

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Remarques :

- `/model` et `/model list` affichent un selecteur compact et numerote (famille de modeles + fournisseurs disponibles).
- `/model <#>` selectionne depuis ce selecteur (et privilegie le fournisseur courant lorsque possible).
- `/model status` affiche la vue detaillee, y compris l’endpoint du fournisseur configure (`baseUrl`) et le mode API (`api`) lorsque disponible.

## Debug overrides

`/debug` vous permet de definir des surcharges de configuration **uniquement a l’execution** (memoire, pas disque). Reserve au proprietaire. Desactive par defaut ; activez avec `commands.debug: true`.

Exemples :

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Remarques :

- Les surcharges s’appliquent immediatement aux nouvelles lectures de configuration, mais **n’ecrivent pas** dans `openclaw.json`.
- Utilisez `/debug reset` pour effacer toutes les surcharges et revenir a la configuration sur disque.

## Mises a jour de configuration

`/config` ecrit dans votre configuration sur disque (`openclaw.json`). Reserve au proprietaire. Desactive par defaut ; activez avec `commands.config: true`.

Exemples :

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Remarques :

- La configuration est validee avant l’ecriture ; les modifications invalides sont rejetees.
- Les mises a jour `/config` persistent apres les redemarrages.

## Notes par surface

- **Commandes texte** s’executent dans la session de chat normale (les messages prives partagent `main`, les groupes ont leur propre session).
- **Commandes natives** utilisent des sessions isolees :
  - Discord : `agent:<agentId>:discord:slash:<userId>`
  - Slack : `agent:<agentId>:slack:slash:<userId>` (prefixe configurable via `channels.slack.slashCommand.sessionPrefix`)
  - Telegram : `telegram:slash:<userId>` (cible la session de chat via `CommandTargetSessionKey`)
- **`/stop`** cible la session de chat active afin d’interrompre l’execution en cours.
- **Slack :** `channels.slack.slashCommand` est toujours pris en charge pour une seule commande de type `/openclaw`. Si vous activez `commands.native`, vous devez creer une commande slash Slack par commande integree (memes noms que `/help`). Les menus d’arguments de commandes pour Slack sont fournis sous forme de boutons Block Kit ephemeres.
