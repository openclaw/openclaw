---
summary: "Interface utilisateur terminal (TUI) : connectez-vous à la Passerelle depuis n'importe quelle machine"
read_when:
  - Vous voulez une présentation conviviale pour débutants de la TUI
  - Vous avez besoin de la liste complète des fonctionnalités, commandes et raccourcis TUI
title: "TUI"
---

# TUI (Interface utilisateur terminal)

## Démarrage rapide

1. Démarrez la Passerelle.

```bash
openclaw gateway
```

2. Ouvrez la TUI.

```bash
openclaw tui
```

3. Tapez un message et appuyez sur Entrée.

Passerelle distante :

```bash
openclaw tui --url ws://<hôte>:<port> --token <gateway-token>
```

Utilisez `--password` si votre Passerelle utilise l'authentification par mot de passe.

## Ce que vous voyez

- En-tête : URL de connexion, agent actuel, session actuelle.
- Journal de chat : messages utilisateur, réponses assistant, avis système, cartes d'outils.
- Ligne de statut : état de connexion/exécution (connecting, running, streaming, idle, error).
- Pied de page : état de connexion + agent + session + modèle + think/verbose/reasoning + comptes de tokens + deliver.
- Entrée : éditeur de texte avec autocomplétion.

## Modèle mental : agents + sessions

- Les agents sont des slugs uniques (ex. `main`, `research`). La Passerelle expose la liste.
- Les sessions appartiennent à l'agent actuel.
- Les clés de session sont stockées comme `agent:<agentId>:<sessionKey>`.
  - Si vous tapez `/session main`, la TUI l'étend à `agent:<currentAgent>:main`.
  - Si vous tapez `/session agent:other:main`, vous passez explicitement à cette session d'agent.
- Portée de session :
  - `per-sender` (par défaut) : chaque agent a plusieurs sessions.
  - `global` : la TUI utilise toujours la session `global` (le sélecteur peut être vide).
- L'agent actuel + la session sont toujours visibles dans le pied de page.

## Envoi + livraison

- Les messages sont envoyés à la Passerelle ; la livraison aux fournisseurs est désactivée par défaut.
- Activer la livraison :
  - `/deliver on`
  - ou le panneau Paramètres
  - ou démarrer avec `openclaw tui --deliver`

## Sélecteurs + overlays

- Sélecteur de modèle : lister les modèles disponibles et définir le remplacement de session.
- Sélecteur d'agent : choisir un agent différent.
- Sélecteur de session : montre uniquement les sessions pour l'agent actuel.
- Paramètres : basculer deliver, expansion de sortie d'outil et visibilité de thinking.

## Raccourcis clavier

- Entrée : envoyer le message
- Échap : avorter l'exécution active
- Ctrl+C : effacer l'entrée (appuyez deux fois pour quitter)
- Ctrl+D : quitter
- Ctrl+L : sélecteur de modèle
- Ctrl+G : sélecteur d'agent
- Ctrl+P : sélecteur de session
- Ctrl+O : basculer l'expansion de sortie d'outil
- Ctrl+T : basculer la visibilité de thinking (recharge l'historique)

## Commandes slash

Principales :

- `/help`
- `/status`
- `/agent <id>` (ou `/agents`)
- `/session <key>` (ou `/sessions`)
- `/model <fournisseur/modèle>` (ou `/models`)

Contrôles de session :

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias : `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Cycle de vie de session :

- `/new` ou `/reset` (réinitialiser la session)
- `/abort` (avorter l'exécution active)
- `/settings`
- `/exit`

Autres commandes slash de Passerelle (par exemple, `/context`) sont transférées à la Passerelle et montrées comme sortie système. Voir [Commandes slash](/fr-FR/tools/slash-commands).

## Commandes shell locales

- Préfixez une ligne avec `!` pour exécuter une commande shell locale sur l'hôte TUI.
- La TUI demande une fois par session d'autoriser l'exécution locale ; refuser garde `!` désactivé pour la session.
- Les commandes s'exécutent dans un shell frais, non interactif dans le répertoire de travail TUI (pas de `cd`/env persistant).
- Un `!` seul est envoyé comme un message normal ; les espaces de début ne déclenchent pas l'exec local.

## Sortie d'outil

- Les appels d'outils s'affichent sous forme de cartes avec args + résultats.
- Ctrl+O bascule entre les vues repliées/étendues.
- Pendant que les outils s'exécutent, les mises à jour partielles streament dans la même carte.

## Historique + streaming

- À la connexion, la TUI charge le dernier historique (par défaut 200 messages).
- Les réponses en streaming se mettent à jour sur place jusqu'à finalisation.
- La TUI écoute aussi les événements d'outil d'agent pour des cartes d'outils plus riches.

## Détails de connexion

- La TUI s'enregistre auprès de la Passerelle comme `mode: "tui"`.
- Les reconnexions montrent un message système ; les lacunes d'événements sont affichées dans le journal.

## Options

- `--url <url>` : URL WebSocket de Passerelle (par défaut config ou `ws://127.0.0.1:<port>`)
- `--token <token>` : Token de passerelle (si requis)
- `--password <password>` : Mot de passe de passerelle (si requis)
- `--session <key>` : Clé de session (par défaut : `main`, ou `global` quand la portée est globale)
- `--deliver` : Livrer les réponses assistant au fournisseur (par défaut désactivé)
- `--thinking <level>` : Remplacer le niveau de thinking pour les envois
- `--timeout-ms <ms>` : Timeout d'agent en ms (par défaut `agents.defaults.timeoutSeconds`)

Note : quand vous définissez `--url`, la TUI ne replie pas vers les identifiants de config ou d'environnement.
Passez `--token` ou `--password` explicitement. Les identifiants explicites manquants sont une erreur.

## Dépannage

Pas de sortie après l'envoi d'un message :

- Exécutez `/status` dans la TUI pour confirmer que la Passerelle est connectée et idle/occupée.
- Vérifiez les journaux de Passerelle : `openclaw logs --follow`.
- Confirmez que l'agent peut s'exécuter : `openclaw status` et `openclaw models status`.
- Si vous attendez des messages dans un canal de chat, activez la livraison (`/deliver on` ou `--deliver`).
- `--history-limit <n>` : Entrées d'historique à charger (par défaut 200)

## Dépannage de connexion

- `disconnected` : assurez-vous que la Passerelle fonctionne et que vos `--url/--token/--password` sont corrects.
- Pas d'agents dans le sélecteur : vérifiez `openclaw agents list` et votre config de routage.
- Sélecteur de session vide : vous êtes peut-être en portée globale ou n'avez pas encore de sessions.
