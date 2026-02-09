---
summary: "Syntaxe des directives pour /think + /verbose et leur impact sur le raisonnement du modele"
read_when:
  - Ajuster l’analyse des directives de thinking ou verbose, ou leurs valeurs par defaut
title: "Niveaux de thinking"
---

# Niveaux de thinking (directives /think)

## Ce que cela fait

- Directive en ligne dans tout corps entrant : `/t <level>`, `/think:<level>` ou `/thinking <level>`.
- Niveaux (alias) : `off | minimal | low | medium | high | xhigh` (modeles GPT-5.2 + Codex uniquement)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (budget maximal)
  - xhigh → “ultrathink+” (modeles GPT-5.2 + Codex uniquement)
  - `x-high`, `x_high`, `extra-high`, `extra high` et `extra_high` sont mappes vers `xhigh`.
  - `highest`, `max` sont mappes vers `high`.
- Notes du fournisseur :
  - Z.AI (`zai/*`) ne prend en charge qu’un thinking binaire (`on`/`off`). Tout niveau non `off` est traite comme `on` (mappe vers `low`).

## Ordre de resolution

1. Directive en ligne sur le message (s’applique uniquement a ce message).
2. Surcharge de session (definie en envoyant un message compose uniquement d’une directive).
3. Valeur par defaut globale (`agents.defaults.thinkingDefault` dans la configuration).
4. Repli : low pour les modeles capables de raisonner ; off sinon.

## Definir une valeur par defaut de session

- Envoyez un message qui est **uniquement** la directive (espaces autorises), par ex. `/think:medium` ou `/t high`.
- Cela persiste pour la session en cours (par emetteur par defaut) ; efface par `/think:off` ou reinitialisation apres inactivite de la session.
- Une reponse de confirmation est envoyee (`Thinking level set to high.` / `Thinking disabled.`). Si le niveau est invalide (par ex. `/thinking big`), la commande est rejetee avec une indication et l’etat de la session reste inchange.
- Envoyez `/think` (ou `/think:`) sans argument pour voir le niveau de thinking actuel.

## Application par agent

- **Pi integre** : le niveau resolu est transmis au runtime de l’agent Pi en processus.

## Directives verbose (/verbose ou /v)

- Niveaux : `on` (minimal) | `full` | `off` (par defaut).
- Un message compose uniquement de la directive bascule le verbose de session et repond `Verbose logging enabled.` / `Verbose logging disabled.` ; les niveaux invalides renvoient une indication sans modifier l’etat.
- `/verbose off` stocke une surcharge explicite de session ; effacez-la via l’UI Sessions en choisissant `inherit`.
- La directive en ligne n’affecte que ce message ; les valeurs par defaut de session/globales s’appliquent sinon.
- Envoyez `/verbose` (ou `/verbose:`) sans argument pour voir le niveau verbose actuel.
- Lorsque le verbose est active, les agents qui emettent des resultats d’outils structures (Pi, autres agents JSON) renvoient chaque appel d’outil comme son propre message de metadonnees uniquement, prefixe par `<emoji> <tool-name>: <arg>` lorsque disponible (chemin/commande). Ces resumes d’outils sont envoyes des que chaque outil demarre (bulles separees), et non sous forme de deltas en streaming.
- Lorsque le verbose est `full`, les sorties d’outils sont egalement transmises apres l’execution (bulle separee, tronquee a une longueur sure). Si vous basculez `/verbose on|full|off` pendant qu’une execution est en cours, les bulles d’outils suivantes respectent le nouveau reglage.

## Visibilite du raisonnement (/reasoning)

- Niveaux : `on|off|stream`.
- Un message compose uniquement de la directive bascule l’affichage des blocs de thinking dans les reponses.
- Lorsqu’elle est activee, le raisonnement est envoye comme un **message separe** prefixe par `Reasoning:`.
- `stream` (Telegram uniquement) : diffuse le raisonnement dans la bulle de brouillon Telegram pendant la generation de la reponse, puis envoie la reponse finale sans raisonnement.
- Alias : `/reason`.
- Envoyez `/reasoning` (ou `/reasoning:`) sans argument pour voir le niveau de raisonnement actuel.

## Associe

- La documentation du mode eleve se trouve dans [Elevated mode](/tools/elevated).

## Heartbeats

- Le corps de la sonde de heartbeat est l’invite de heartbeat configuree (par defaut : `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Les directives en ligne dans un message de heartbeat s’appliquent comme d’habitude (mais evitez de modifier les valeurs par defaut de session a partir des heartbeats).
- La livraison du heartbeat envoie par defaut uniquement la charge finale. Pour envoyer aussi le message separe `Reasoning:` (lorsqu’il est disponible), definissez `agents.defaults.heartbeat.includeReasoning: true` ou, par agent, `agents.list[].heartbeat.includeReasoning: true`.

## Interface Web chat

- Le selecteur de thinking du chat web reflète le niveau stocke de la session a partir du magasin/configuration de session entrant(e) au chargement de la page.
- Choisir un autre niveau s’applique uniquement au message suivant (`thinkingOnce`) ; apres l’envoi, le selecteur revient au niveau de session stocke.
- Pour modifier la valeur par defaut de la session, envoyez une directive `/think:<level>` (comme precedemment) ; le selecteur la refletera apres le prochain rechargement.
