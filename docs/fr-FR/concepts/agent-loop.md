---
summary: "Cycle de vie de la boucle d'agent, flux et sémantique d'attente"
read_when:
  - Vous avez besoin d'un parcours exact de la boucle d'agent ou des événements de cycle de vie
title: "Boucle d'agent"
---

# Boucle d'agent (OpenClaw)

Une boucle agentique est l'exécution "réelle" complète d'un agent : réception → assemblage du contexte → inférence du modèle →
exécution d'outils → réponses en streaming → persistance. C'est le chemin autoritaire qui transforme un message
en actions et une réponse finale, tout en gardant l'état de session cohérent.

Dans OpenClaw, une boucle est une exécution unique et sérialisée par session qui émet des événements de cycle de vie et de flux
pendant que le modèle réfléchit, appelle des outils et streame la sortie. Ce document explique comment cette boucle authentique est
câblée de bout en bout.

## Points d'entrée

- RPC de passerelle : `agent` et `agent.wait`.
- CLI : commande `agent`.

## Comment ça fonctionne (haut niveau)

1. Le RPC `agent` valide les paramètres, résout la session (sessionKey/sessionId), persiste les métadonnées de session, retourne `{ runId, acceptedAt }` immédiatement.
2. `agentCommand` exécute l'agent :
   - résout le modèle + valeurs par défaut thinking/verbose
   - charge l'instantané de compétences
   - appelle `runEmbeddedPiAgent` (environnement d'exécution pi-agent-core)
   - émet **fin/erreur de cycle de vie** si la boucle embarquée n'en émet pas une
3. `runEmbeddedPiAgent` :
   - sérialise les exécutions via des files d'attente par session + globales
   - résout le modèle + profil d'authentification et construit la session pi
   - s'abonne aux événements pi et streame les deltas assistant/outil
   - applique le timeout → abandonne l'exécution si dépassé
   - retourne les charges utiles + métadonnées d'utilisation
4. `subscribeEmbeddedPiSession` fait le pont entre les événements pi-agent-core et le flux `agent` d'OpenClaw :
   - événements d'outils => `stream: "tool"`
   - deltas assistant => `stream: "assistant"`
   - événements de cycle de vie => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` utilise `waitForAgentJob` :
   - attend la **fin/erreur de cycle de vie** pour `runId`
   - retourne `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Mise en file d'attente + concurrence

- Les exécutions sont sérialisées par clé de session (voie de session) et optionnellement via une voie globale.
- Cela empêche les courses d'outils/session et garde l'historique de session cohérent.
- Les canaux de messagerie peuvent choisir des modes de file d'attente (collect/steer/followup) qui alimentent ce système de voies.
  Voir [File d'attente de commandes](/fr-FR/concepts/queue).

## Préparation de session + espace de travail

- L'espace de travail est résolu et créé ; les exécutions en sandbox peuvent rediriger vers une racine d'espace de travail en sandbox.
- Les compétences sont chargées (ou réutilisées depuis un instantané) et injectées dans l'env et l'invite.
- Les fichiers d'amorçage/contexte sont résolus et injectés dans le rapport d'invite système.
- Un verrou d'écriture de session est acquis ; `SessionManager` est ouvert et préparé avant le streaming.

## Assemblage d'invite + invite système

- L'invite système est construite à partir de l'invite de base d'OpenClaw, de l'invite de compétences, du contexte d'amorçage et des remplacements par exécution.
- Les limites spécifiques au modèle et les jetons de réserve de compaction sont appliqués.
- Voir [Invite système](/fr-FR/concepts/system-prompt) pour ce que le modèle voit.

## Points d'accroche (où vous pouvez intercepter)

OpenClaw a deux systèmes d'accroche :

- **Accroches internes** (accroches de passerelle) : scripts pilotés par événements pour les commandes et événements de cycle de vie.
- **Accroches de plugin** : points d'extension à l'intérieur du cycle de vie agent/outil et du pipeline de passerelle.

### Accroches internes (accroches de passerelle)

- **`agent:bootstrap`** : s'exécute lors de la construction des fichiers d'amorçage avant que l'invite système ne soit finalisée.
  Utilisez ceci pour ajouter/retirer des fichiers de contexte d'amorçage.
- **Accroches de commandes** : `/new`, `/reset`, `/stop` et autres événements de commande (voir doc Hooks).

Voir [Hooks](/fr-FR/automation/hooks) pour la configuration et des exemples.

### Accroches de plugin (cycle de vie agent + passerelle)

Celles-ci s'exécutent à l'intérieur de la boucle d'agent ou du pipeline de passerelle :

- **`before_agent_start`** : injecter du contexte ou remplacer l'invite système avant le démarrage de l'exécution.
- **`agent_end`** : inspecter la liste de messages finale et les métadonnées d'exécution après achèvement.
- **`before_compaction` / `after_compaction`** : observer ou annoter les cycles de compaction.
- **`before_tool_call` / `after_tool_call`** : intercepter les paramètres/résultats d'outils.
- **`tool_result_persist`** : transformer de manière synchrone les résultats d'outils avant qu'ils ne soient écrits dans la transcription de session.
- **`message_received` / `message_sending` / `message_sent`** : accroches de message entrant + sortant.
- **`session_start` / `session_end`** : limites de cycle de vie de session.
- **`gateway_start` / `gateway_stop`** : événements de cycle de vie de passerelle.

Voir [Plugins](/fr-FR/tools/plugin#plugin-hooks) pour l'API d'accroche et les détails d'enregistrement.

## Streaming + réponses partielles

- Les deltas assistant sont streamés depuis pi-agent-core et émis comme événements `assistant`.
- Le streaming par blocs peut émettre des réponses partielles soit sur `text_end` soit sur `message_end`.
- Le streaming de raisonnement peut être émis comme flux séparé ou comme réponses par blocs.
- Voir [Streaming](/fr-FR/concepts/streaming) pour le découpage et le comportement de réponse par blocs.

## Exécution d'outils + outils de messagerie

- Les événements de démarrage/mise à jour/fin d'outil sont émis sur le flux `tool`.
- Les résultats d'outils sont assainis pour la taille et les charges utiles d'image avant journalisation/émission.
- Les envois d'outils de messagerie sont suivis pour supprimer les confirmations assistant en double.

## Façonnage de réponse + suppression

- Les charges utiles finales sont assemblées à partir de :
  - texte assistant (et raisonnement optionnel)
  - résumés d'outils en ligne (quand verbose + autorisé)
  - texte d'erreur assistant quand le modèle erre
- `NO_REPLY` est traité comme un jeton silencieux et filtré des charges utiles sortantes.
- Les doublons d'outils de messagerie sont retirés de la liste de charges utiles finale.
- Si aucune charge utile affichable ne reste et qu'un outil a erré, une réponse d'erreur d'outil de repli est émise
  (sauf si un outil de messagerie a déjà envoyé une réponse visible par l'utilisateur).

## Compaction + réessais

- L'auto-compaction émet des événements de flux `compaction` et peut déclencher un réessai.
- Lors du réessai, les tampons en mémoire et les résumés d'outils sont réinitialisés pour éviter une sortie en double.
- Voir [Compaction](/fr-FR/concepts/compaction) pour le pipeline de compaction.

## Flux d'événements (aujourd'hui)

- `lifecycle` : émis par `subscribeEmbeddedPiSession` (et comme repli par `agentCommand`)
- `assistant` : deltas streamés depuis pi-agent-core
- `tool` : événements d'outils streamés depuis pi-agent-core

## Gestion des canaux de chat

- Les deltas assistant sont mis en tampon dans des messages `delta` de chat.
- Un `final` de chat est émis sur **fin/erreur de cycle de vie**.

## Timeouts

- `agent.wait` par défaut : 30s (juste l'attente). Le paramètre `timeoutMs` remplace.
- Environnement d'exécution de l'agent : `agents.defaults.timeoutSeconds` par défaut 600s ; appliqué dans le minuteur d'abandon `runEmbeddedPiAgent`.

## Où les choses peuvent finir tôt

- Timeout d'agent (abandon)
- AbortSignal (annulation)
- Déconnexion de passerelle ou timeout RPC
- Timeout `agent.wait` (attente seulement, n'arrête pas l'agent)
