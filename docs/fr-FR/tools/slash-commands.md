---
summary: "Commandes slash : texte vs native, config et commandes supportées"
read_when:
  - Utilisation ou configuration commandes chat
  - Débogage routage commande ou permissions
title: "Commandes Slash"
---

# Commandes slash

Les commandes sont gérées par la Passerelle. La plupart des commandes doivent être envoyées comme un message **standalone** qui commence par `/`.
La commande chat bash host-only utilise `! <cmd>` (avec `/bash <cmd>` comme alias).

Il y a deux systèmes reliés :

- **Commandes** : messages standalone `/...`.
- **Directives** : `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Les directives sont retirées du message avant que le modèle ne le voie.
  - Dans les messages chat normaux (pas directive uniquement), elles sont traitées comme "hints inline" et ne persistent **pas** les paramètres session.
  - Dans les messages directive uniquement (le message contient uniquement des directives), elles persistent vers la session et répondent avec un acquittement.
  - Les directives sont appliquées uniquement pour les **expéditeurs autorisés**. Si `commands.allowFrom` est défini, c'est la seule
    allowlist utilisée ; sinon l'autorisation vient des allowlists canal/appairage plus `commands.useAccessGroups`.
    Les expéditeurs non autorisés voient les directives traitées comme texte brut.

Il y a aussi quelques **raccourcis inline** (expéditeurs allowlistés/autorisés uniquement) : `/help`, `/commands`, `/status`, `/whoami` (`/id`).
Ils s'exécutent immédiatement, sont retirés avant que le modèle ne voie le message, et le texte restant continue à travers le flux normal.

## Config

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
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

- `commands.text` (défaut `true`) active le parsing `/...` dans les messages chat.
  - Sur les surfaces sans commandes natives (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), les commandes texte fonctionnent toujours même si vous définissez ceci à `false`.
- `commands.native` (défaut `"auto"`) enregistre les commandes natives.
  - Auto : on pour Discord/Telegram ; off pour Slack (jusqu'à ce que vous ajoutiez des commandes slash) ; ignoré pour les fournisseurs sans support natif.
  - Définissez `channels.discord.commands.native`, `channels.telegram.commands.native`, ou `channels.slack.commands.native` pour remplacer par fournisseur (bool ou `"auto"`).
  - `false` efface les commandes précédemment enregistrées sur Discord/Telegram au démarrage. Les commandes Slack sont gérées dans l'app Slack et ne sont pas supprimées automatiquement.
- `commands.nativeSkills` (défaut `"auto"`) enregistre les commandes **compétence** nativement quand supporté.
  - Auto : on pour Discord/Telegram ; off pour Slack (Slack nécessite création d'une commande slash par compétence).
  - Définissez `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, ou `channels.slack.commands.nativeSkills` pour remplacer par fournisseur (bool ou `"auto"`).
- `commands.bash` (défaut `false`) active `! <cmd>` pour exécuter des commandes shell hôte (`/bash <cmd>` est un alias ; nécessite allowlists `tools.elevated`).
- `commands.bashForegroundMs` (défaut `2000`) contrôle combien de temps bash attend avant de basculer en mode background (`0` backgrounde immédiatement).
- `commands.config` (défaut `false`) active `/config` (lit/écrit `openclaw.json`).
- `commands.debug` (défaut `false`) active `/debug` (overrides runtime uniquement).
- `commands.allowFrom` (optionnel) définit une allowlist par fournisseur pour autorisation commande. Quand configuré, c'est la
  seule source autorisation pour commandes et directives (allowlists canal/appairage et `commands.useAccessGroups`
  sont ignorés). Utilisez `"*"` pour un défaut global ; les clés spécifiques fournisseur le remplacent.
- `commands.useAccessGroups` (défaut `true`) applique allowlists/politiques pour commandes quand `commands.allowFrom` n'est pas défini.

## Liste commandes

Texte + native (quand activé) :

- `/help`
- `/commands`
- `/skill <name> [input]` (exécuter une compétence par nom)
- `/status` (afficher statut actuel ; inclut usage/quota fournisseur pour le fournisseur modèle actuel quand disponible)
- `/allowlist` (lister/ajouter/supprimer entrées allowlist)
- `/approve <id> allow-once|allow-always|deny` (résoudre les prompts approbation exec)
- `/context [list|detail|json]` (expliquer "context" ; `detail` montre taille par fichier + par outil + par compétence + prompt système)
- `/whoami` (afficher votre id expéditeur ; alias : `/id`)
- `/subagents list|kill|log|info|send|steer` (inspecter, tuer, logger ou diriger les exécutions sous-agent pour la session actuelle)
- `/kill <id|#|all>` (avorter immédiatement un ou tous les sous-agents en cours pour cette session ; pas de message confirmation)
- `/steer <id|#> <message>` (diriger un sous-agent en cours immédiatement : in-run quand possible, sinon avorter travail actuel et redémarrer sur le message steer)
- `/tell <id|#> <message>` (alias pour `/steer`)
- `/config show|get|set|unset` (persister config sur disque, owner uniquement ; nécessite `commands.config: true`)
- `/debug show|set|unset|reset` (overrides runtime, owner uniquement ; nécessite `commands.debug: true`)
- `/usage off|tokens|full|cost` (footer usage par réponse ou résumé coût local)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (contrôler TTS ; voir [/tts](/fr-FR/tts))
  - Discord : commande native est `/voice` (Discord réserve `/tts`) ; texte `/tts` fonctionne toujours.
- `/stop`
- `/restart`
- `/dock-telegram` (alias : `/dock_telegram`) (basculer réponses vers Telegram)
- `/dock-discord` (alias : `/dock_discord`) (basculer réponses vers Discord)
- `/dock-slack` (alias : `/dock_slack`) (basculer réponses vers Slack)
- `/activation mention|always` (groupes uniquement)
- `/send on|off|inherit` (owner uniquement)
- `/reset` ou `/new [model]` (hint modèle optionnel ; le reste est passé through)
- `/think <off|minimal|low|medium|high|xhigh>` (choix dynamiques par modèle/fournisseur ; alias : `/thinking`, `/t`)
- `/verbose on|full|off` (alias : `/v`)
- `/reasoning on|off|stream` (alias : `/reason` ; quand on, envoie un message séparé préfixé `Raisonnement :` ; `stream` = brouillon Telegram uniquement)
- `/elevated on|off|ask|full` (alias : `/elev` ; `full` saute approbations exec)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (envoyer `/exec` pour afficher actuel)
- `/model <name>` (alias : `/models` ; ou `/<alias>` depuis `agents.defaults.models.*.alias`)
- `/queue <mode>` (plus options comme `debounce:2s cap:25 drop:summarize` ; envoyer `/queue` pour voir paramètres actuels)
- `/bash <command>` (host uniquement ; alias pour `! <command>` ; nécessite `commands.bash: true` + allowlists `tools.elevated`)

Texte uniquement :

- `/compact [instructions]` (voir [/concepts/compaction](/fr-FR/concepts/compaction))
- `! <command>` (host uniquement ; un à la fois ; utiliser `!poll` + `!stop` pour jobs long-running)
- `!poll` (vérifier sortie / status ; accepte `sessionId` optionnel ; `/bash poll` fonctionne aussi)
- `!stop` (arrêter le job bash en cours ; accepte `sessionId` optionnel ; `/bash stop` fonctionne aussi)

Notes :

- Les commandes acceptent un `:` optionnel entre la commande et args (par ex. `/think: high`, `/send: on`, `/help:`).
- `/new <model>` accepte un alias modèle, `provider/model`, ou un nom fournisseur (correspondance floue) ; si pas de correspondance, le texte est traité comme corps message.
- Pour la répartition usage fournisseur complète, utilisez `openclaw status --usage`.
- `/allowlist add|remove` nécessite `commands.config=true` et honore canal `configWrites`.
- `/usage` contrôle le footer usage par réponse ; `/usage cost` affiche un résumé coût local depuis les logs session OpenClaw.
- `/restart` est désactivé par défaut ; définissez `commands.restart: true` pour l'activer.
- `/verbose` est destiné au débogage et visibilité supplémentaire ; gardez-le **off** en usage normal.
- `/reasoning` (et `/verbose`) sont risqués dans les paramètres groupe : ils peuvent révéler raisonnement interne ou sortie outil que vous n'aviez pas l'intention d'exposer. Préférez les laisser off, surtout dans les chats groupe.
- **Chemin rapide :** les messages commande uniquement depuis expéditeurs allowlistés sont gérés immédiatement (contourner queue + modèle).
- **Gating mention groupe :** les messages commande uniquement depuis expéditeurs allowlistés contournent les exigences mention.
- **Raccourcis inline (expéditeurs allowlistés uniquement) :** certaines commandes fonctionnent aussi quand embarquées dans un message normal et sont retirées avant que le modèle ne voie le texte restant.
  - Exemple : `hey /status` déclenche une réponse status, et le texte restant continue à travers le flux normal.
- Actuellement : `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Les messages commande uniquement non autorisés sont silencieusement ignorés, et les jetons inline `/...` sont traités comme texte brut.
- **Commandes compétence :** les compétences `user-invocable` sont exposées comme commandes slash. Les noms sont nettoyés vers `a-z0-9_` (max 32 chars) ; les collisions obtiennent des suffixes numériques (par ex. `_2`).
  - `/skill <name> [input]` exécute une compétence par nom (utile quand les limites commande native empêchent les commandes par compétence).
  - Par défaut, les commandes compétence sont forwardées au modèle comme une requête normale.
  - Les compétences peuvent optionnellement déclarer `command-dispatch: tool` pour router la commande directement vers un outil (déterministe, pas de modèle).
  - Exemple : `/prose` (plugin OpenProse) — voir [OpenProse](/fr-FR/prose).
- **Arguments commande native :** Discord utilise l'autocomplétion pour options dynamiques (et menus bouton quand vous omettez args requis). Telegram et Slack montrent un menu bouton quand une commande supporte des choix et vous omettez l'arg.

## Surfaces usage (ce qui s'affiche où)

- **Usage/quota fournisseur** (exemple : "Claude 80% restant") s'affiche dans `/status` pour le fournisseur modèle actuel quand le tracking usage est activé.
- **Jetons/coût par réponse** est contrôlé par `/usage off|tokens|full` (ajouté aux réponses normales).
- `/model status` concerne **modèles/auth/endpoints**, pas l'usage.

## Sélection modèle (`/model`)

`/model` est implémenté comme une directive.

Exemples :

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Notes :

- `/model` et `/model list` montrent un picker compact, numéroté (famille modèle + fournisseurs disponibles).
- `/model <#>` sélectionne depuis ce picker (et préfère le fournisseur actuel quand possible).
- `/model status` montre la vue détaillée, incluant endpoint fournisseur configuré (`baseUrl`) et mode API (`api`) quand disponible.

## Overrides debug

`/debug` vous permet de définir des overrides config **runtime uniquement** (mémoire, pas disque). Owner uniquement. Désactivé par défaut ; activer avec `commands.debug: true`.

Exemples :

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notes :

- Les overrides s'appliquent immédiatement aux nouvelles lectures config, mais n'écrivent **pas** vers `openclaw.json`.
- Utilisez `/debug reset` pour effacer tous les overrides et retourner à la config sur disque.

## Mises à jour config

`/config` écrit vers votre config sur disque (`openclaw.json`). Owner uniquement. Désactivé par défaut ; activer avec `commands.config: true`.

Exemples :

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Notes :

- La config est validée avant écriture ; les changements invalides sont rejetés.
- Les mises à jour `/config` persistent à travers les redémarrages.

## Notes surface

- **Commandes texte** s'exécutent dans la session chat normale (les DMs partagent `main`, les groupes ont leur propre session).
- **Commandes natives** utilisent des sessions isolées :
  - Discord : `agent:<agentId>:discord:slash:<userId>`
  - Slack : `agent:<agentId>:slack:slash:<userId>` (préfixe configurable via `channels.slack.slashCommand.sessionPrefix`)
  - Telegram : `telegram:slash:<userId>` (cible la session chat via `CommandTargetSessionKey`)
- **`/stop`** cible la session chat active donc elle peut avorter l'exécution actuelle.
- **Slack :** `channels.slack.slashCommand` est toujours supporté pour une seule commande style `/openclaw`. Si vous activez `commands.native`, vous devez créer une commande slash Slack par commande intégrée (mêmes noms que `/help`). Les menus argument commande pour Slack sont livrés comme boutons Block Kit éphémères.
