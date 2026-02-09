---
summary: "Interface utilisateur en terminal (TUI) : se connecter à la Gateway (passerelle) depuis n’importe quelle machine"
read_when:
  - Vous voulez un guide pas à pas pour débutants sur la TUI
  - Vous avez besoin de la liste complète des fonctionnalités, commandes et raccourcis de la TUI
title: "TUI"
---

# TUI (Terminal UI)

## Démarrage rapide

1. Démarrez la Gateway (passerelle).

```bash
openclaw gateway
```

2. Ouvrez la TUI.

```bash
openclaw tui
```

3. Saisissez un message et appuyez sur Entrée.

Gateway (passerelle) distante :

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Utilisez `--password` si votre Gateway (passerelle) utilise l’authentification par mot de passe.

## Ce que vous voyez

- En‑tête : URL de connexion, agent courant, session courante.
- Journal de discussion : messages utilisateur, réponses de l’assistant, avis système, cartes d’outils.
- Ligne d’état : état de connexion/exécution (connexion, en cours, streaming, inactif, erreur).
- Pied de page : état de connexion + agent + session + modèle + réflexion/verbeux/raisonnement + compteurs de jetons + livraison.
- Entrée : éditeur de texte avec autocomplétion.

## Modèle mental : agents + sessions

- Les agents sont des slugs uniques (par ex. `main`, `research`). La Gateway (passerelle) expose la liste.
- Les sessions appartiennent à l’agent courant.
- Les clés de session sont stockées sous `agent:<agentId>:<sessionKey>`.
  - Si vous saisissez `/session main`, la TUI l’étend en `agent:<currentAgent>:main`.
  - Si vous saisissez `/session agent:other:main`, vous basculez explicitement vers la session de cet agent.
- Portée de session :
  - `per-sender` (par défaut) : chaque agent a plusieurs sessions.
  - `global` : la TUI utilise toujours la session `global` (le sélecteur peut être vide).
- L’agent courant + la session sont toujours visibles dans le pied de page.

## Envoi + livraison

- Les messages sont envoyés à la Gateway (passerelle) ; la livraison aux fournisseurs est désactivée par défaut.
- Activer la livraison :
  - `/deliver on`
  - ou le panneau Paramètres
  - ou démarrer avec `openclaw tui --deliver`

## Sélecteurs + superpositions

- Sélecteur de modèle : liste des modèles disponibles et définition de la surcharge de session.
- Sélecteur d’agent : choisir un agent différent.
- Sélecteur de session : n’affiche que les sessions de l’agent courant.
- Paramètres : activer/désactiver la livraison, l’extension de la sortie des outils et la visibilité de la réflexion.

## Raccourcis clavier

- Entrée : envoyer le message
- Échap : interrompre l’exécution active
- Ctrl+C : effacer l’entrée (appuyez deux fois pour quitter)
- Ctrl+D : quitter
- Ctrl+L : sélecteur de modèle
- Ctrl+G : sélecteur d’agent
- Ctrl+P : sélecteur de session
- Ctrl+O : basculer l’extension de la sortie des outils
- Ctrl+T : basculer la visibilité de la réflexion (recharge l’historique)

## Commandes slash

Cœur :

- `/help`
- `/status`
- `/agent <id>` (ou `/agents`)
- `/session <key>` (ou `/sessions`)
- `/model <provider/model>` (ou `/models`)

Contrôles de session :

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias : `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Cycle de vie des sessions :

- `/new` ou `/reset` (réinitialiser la session)
- `/abort` (interrompre l’exécution active)
- `/settings`
- `/exit`

Les autres commandes slash de la Gateway (passerelle) (par exemple, `/context`) sont transmises à la Gateway (passerelle) et affichées comme sortie système. Voir [Slash commands](/tools/slash-commands).

## Commandes shell locales

- Préfixez une ligne avec `!` pour exécuter une commande shell locale sur l’hôte de la TUI.
- La TUI demande une autorisation une fois par session pour permettre l’exécution locale ; refuser maintient `!` désactivé pour la session.
- Les commandes s’exécutent dans un shell frais et non interactif, dans le répertoire de travail de la TUI (pas de `cd`/env persistants).
- Un `!` seul est envoyé comme message normal ; les espaces en tête ne déclenchent pas l’exécution locale.

## Sortie des outils

- Les appels d’outils s’affichent sous forme de cartes avec arguments + résultats.
- Ctrl+O bascule entre les vues réduite/étendue.
- Pendant l’exécution des outils, des mises à jour partielles sont diffusées dans la même carte.

## Historique + streaming

- À la connexion, la TUI charge le dernier historique (200 messages par défaut).
- Les réponses en streaming se mettent à jour en place jusqu’à finalisation.
- La TUI écoute également les événements d’outils de l’agent pour des cartes d’outils plus riches.

## Détails de connexion

- La TUI s’enregistre auprès de la Gateway (passerelle) en tant que `mode: "tui"`.
- Les reconnexions affichent un message système ; les écarts d’événements apparaissent dans le journal.

## Options

- `--url <url>` : URL WebSocket de la Gateway (passerelle) (par défaut depuis la configuration ou `ws://127.0.0.1:<port>`)
- `--token <token>` : jeton de la Gateway (passerelle) (si requis)
- `--password <password>` : mot de passe de la Gateway (passerelle) (si requis)
- `--session <key>` : clé de session (par défaut : `main`, ou `global` lorsque la portée est globale)
- `--deliver` : livrer les réponses de l’assistant au fournisseur (désactivé par défaut)
- `--thinking <level>` : remplacer le niveau de réflexion pour les envois
- `--timeout-ms <ms>` : délai d’expiration de l’agent en ms (par défaut : `agents.defaults.timeoutSeconds`)

Remarque : lorsque vous définissez `--url`, la TUI ne revient pas aux identifiants de configuration ou d’environnement.
Passez explicitement `--token` ou `--password`. L’absence d’identifiants explicites est une erreur.

## Problemes courants

Aucune sortie après l’envoi d’un message :

- Exécutez `/status` dans la TUI pour confirmer que la Gateway (passerelle) est connectée et inactive/occupée.
- Vérifiez les journaux de la Gateway (passerelle) : `openclaw logs --follow`.
- Confirmez que l’agent peut s’exécuter : `openclaw status` et `openclaw models status`.
- Si vous attendez des messages dans un canal de discussion, activez la livraison (`/deliver on` ou `--deliver`).
- `--history-limit <n>` : entrées d’historique à charger (200 par défaut)

## Dépannage de connexion

- `disconnected` : assurez‑vous que la Gateway (passerelle) est en cours d’exécution et que vos `--url/--token/--password` sont corrects.
- Aucun agent dans le sélecteur : vérifiez `openclaw agents list` et votre configuration de routage.
- Sélecteur de session vide : vous êtes peut‑être en portée globale ou vous n’avez pas encore de sessions.
