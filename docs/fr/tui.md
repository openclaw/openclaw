---
summary: « Interface utilisateur terminal (TUI) : se connecter au Gateway (passerelle) depuis n’importe quelle machine »
read_when:
  - Vous souhaitez un guide pas à pas convivial pour debutants du TUI
  - Vous avez besoin de la liste complete des fonctionnalites, commandes et raccourcis du TUI
title: « TUI »
x-i18n:
  source_path: tui.md
  source_hash: 1eb111456fe0aab6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:03:17Z
---

# TUI (Terminal UI)

## Demarrage rapide

1. Demarrez le Gateway (passerelle).

```bash
openclaw gateway
```

2. Ouvrez le TUI.

```bash
openclaw tui
```

3. Saisissez un message et appuyez sur Entree.

Gateway distant :

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Utilisez `--password` si votre Gateway (passerelle) utilise l’authentification par mot de passe.

## Ce que vous voyez

- En-tete : URL de connexion, agent actuel, session actuelle.
- Journal de discussion : messages utilisateur, reponses de l’assistant, avis systeme, cartes d’outils.
- Ligne d’etat : etat de connexion/d’execution (connexion, en cours, streaming, inactif, erreur).
- Pied de page : etat de connexion + agent + session + modele + penser/verbeux/raisonnement + compteurs de tokens + livraison.
- Saisie : editeur de texte avec autocompletion.

## Modele mental : agents + sessions

- Les agents sont des identifiants uniques (p. ex. `main`, `research`). Le Gateway (passerelle) expose la liste.
- Les sessions appartiennent a l’agent actuel.
- Les cles de session sont stockees comme `agent:<agentId>:<sessionKey>`.
  - Si vous tapez `/session main`, le TUI l’etend en `agent:<currentAgent>:main`.
  - Si vous tapez `/session agent:other:main`, vous basculez explicitement vers cette session d’agent.
- Portee de session :
  - `per-sender` (par defaut) : chaque agent a plusieurs sessions.
  - `global` : le TUI utilise toujours la session `global` (le selecteur peut etre vide).
- L’agent + la session actuels sont toujours visibles dans le pied de page.

## Envoi + livraison

- Les messages sont envoyes au Gateway (passerelle) ; la livraison vers les fournisseurs est desactivee par defaut.
- Activer la livraison :
  - `/deliver on`
  - ou le panneau Parametres
  - ou demarrer avec `openclaw tui --deliver`

## Selecteurs + superpositions

- Selecteur de modele : liste des modeles disponibles et definition du remplacement de session.
- Selecteur d’agent : choisir un agent different.
- Selecteur de session : affiche uniquement les sessions pour l’agent actuel.
- Parametres : activer/desactiver la livraison, l’expansion des sorties d’outils et la visibilite de la pensee.

## Raccourcis clavier

- Entree : envoyer le message
- Echap : annuler l’execution active
- Ctrl+C : effacer la saisie (appuyez deux fois pour quitter)
- Ctrl+D : quitter
- Ctrl+L : selecteur de modele
- Ctrl+G : selecteur d’agent
- Ctrl+P : selecteur de session
- Ctrl+O : basculer l’expansion des sorties d’outils
- Ctrl+T : basculer la visibilite de la pensee (recharge l’historique)

## Commandes slash

Noyau :

- `/help`
- `/status`
- `/agent <id>` (ou `/agents`)
- `/session <key>` (ou `/sessions`)
- `/model <provider/model>` (ou `/models`)

Controles de session :

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias : `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Cycle de vie de session :

- `/new` ou `/reset` (reinitialiser la session)
- `/abort` (annuler l’execution active)
- `/settings`
- `/exit`

Les autres commandes slash du Gateway (passerelle) (par exemple, `/context`) sont transferees au Gateway (passerelle) et affichees comme sortie systeme. Voir [Slash commands](/tools/slash-commands).

## Commandes shell locales

- Prefixez une ligne avec `!` pour executer une commande shell locale sur l’hote du TUI.
- Le TUI demande une autorisation une fois par session pour autoriser l’execution locale ; refuser maintient `!` desactive pour la session.
- Les commandes s’executent dans un shell neuf et non interactif dans le repertoire de travail du TUI (pas de `cd`/env persistant).
- Un `!` seul est envoye comme message normal ; les espaces en tete ne declenchent pas l’execution locale.

## Sortie des outils

- Les appels d’outils s’affichent sous forme de cartes avec arguments + resultats.
- Ctrl+O bascule entre vues repliee/depliee.
- Pendant l’execution des outils, des mises a jour partielles sont diffusees dans la meme carte.

## Historique + streaming

- A la connexion, le TUI charge le dernier historique (200 messages par defaut).
- Les reponses en streaming se mettent a jour sur place jusqu’a finalisation.
- Le TUI ecoute egalement les evenements d’outils de l’agent pour des cartes d’outils plus riches.

## Details de connexion

- Le TUI s’enregistre aupres du Gateway (passerelle) comme `mode: "tui"`.
- Les reconnexions affichent un message systeme ; les interruptions d’evenements sont signalees dans le journal.

## Options

- `--url <url>` : URL WebSocket du Gateway (passerelle) (par defaut : configuration ou `ws://127.0.0.1:<port>`)
- `--token <token>` : jeton du Gateway (passerelle) (si requis)
- `--password <password>` : mot de passe du Gateway (passerelle) (si requis)
- `--session <key>` : cle de session (par defaut : `main`, ou `global` lorsque la portee est globale)
- `--deliver` : livrer les reponses de l’assistant au fournisseur (desactive par defaut)
- `--thinking <level>` : remplacer le niveau de pensee pour les envois
- `--timeout-ms <ms>` : delai d’expiration de l’agent en ms (par defaut : `agents.defaults.timeoutSeconds`)

Remarque : lorsque vous definissez `--url`, le TUI ne se rabat pas sur la configuration ni sur les identifiants d’environnement.
Passez explicitement `--token` ou `--password`. L’absence d’identifiants explicites est une erreur.

## Depannage

Aucune sortie apres l’envoi d’un message :

- Executez `/status` dans le TUI pour confirmer que le Gateway (passerelle) est connecte et inactif/occupe.
- Verifiez les journaux du Gateway (passerelle) : `openclaw logs --follow`.
- Confirmez que l’agent peut s’executer : `openclaw status` et `openclaw models status`.
- Si vous attendez des messages dans un canal de discussion, activez la livraison (`/deliver on` ou `--deliver`).
- `--history-limit <n>` : entrees d’historique a charger (200 par defaut)

## Depannage

- `disconnected` : assurez-vous que le Gateway (passerelle) est en cours d’execution et que vos `--url/--token/--password` sont corrects.
- Aucun agent dans le selecteur : verifiez `openclaw agents list` et votre configuration de routage.
- Selecteur de session vide : vous etes peut-etre en portee globale ou vous n’avez pas encore de sessions.
