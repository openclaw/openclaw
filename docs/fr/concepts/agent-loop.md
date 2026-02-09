---
summary: "Cycle de vie de la boucle d’agent, flux et semantique d’attente"
read_when:
  - Vous avez besoin d’un parcours exact de la boucle d’agent ou des evenements de cycle de vie
title: "Boucle d’agent"
---

# Boucle d’agent (OpenClaw)

Une boucle agentique est l’execution complete et « reelle » d’un agent : ingestion → assemblage du contexte → inference du modele →
execution d’outils → reponses en streaming → persistance. C’est le chemin de reference qui transforme un message
en actions et en une reponse finale, tout en maintenant la coherence de l’etat de session.

Dans OpenClaw, une boucle est une execution unique et serialisee par session qui emet des evenements de cycle de vie et de flux
pendant que le modele reflechit, appelle des outils et diffuse la sortie. Ce document explique comment cette boucle authentique est
cablee de bout en bout.

## Points d’entree

- RPC de la Gateway (passerelle) : `agent` et `agent.wait`.
- CLI : commande `agent`.

## Comment ça marche (haut niveau)

1. Le RPC `agent` valide les parametres, resout la session (sessionKey/sessionId), persiste les metadonnees de session et renvoie immediatement `{ runId, acceptedAt }`.
2. `agentCommand` execute l’agent :
   - resout le modele + les valeurs par defaut thinking/verbose
   - charge l’instantane des Skills
   - appelle `runEmbeddedPiAgent` (runtime pi-agent-core)
   - emet **fin/erreur de cycle de vie** si la boucle embarquee n’en emet pas
3. `runEmbeddedPiAgent` :
   - serialise les executions via des files par session + globales
   - resout le modele + le profil d’authentification et construit la session pi
   - s’abonne aux evenements pi et diffuse les deltas assistant/outils
   - applique le delai d’expiration -> interrompt l’execution s’il est depasse
   - renvoie les charges utiles + les metadonnees d’utilisation
4. `subscribeEmbeddedPiSession` fait le pont entre les evenements pi-agent-core et le flux `agent` d’OpenClaw :
   - evenements d’outils => `stream: "tool"`
   - deltas assistant => `stream: "assistant"`
   - evenements de cycle de vie => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` utilise `waitForAgentJob` :
   - attend la **fin/erreur de cycle de vie** pour `runId`
   - renvoie `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## File d'attente + simultanée

- Les executions sont serialisees par cle de session (voie de session) et, en option, via une voie globale.
- Cela evite les conflits d’outils/session et maintient la coherence de l’historique de session.
- Les canaux de messagerie peuvent choisir des modes de file (collect/steer/followup) qui alimentent ce systeme de voies.
  Voir [Command Queue](/concepts/queue).

## Preparation de la session + de l’espace de travail

- L’espace de travail est resolu et cree ; les executions en sandbox peuvent rediriger vers une racine d’espace de travail sandbox.
- Les Skills sont charges (ou reutilises depuis un instantane) et injectes dans l’environnement et le prompt.
- Les fichiers de bootstrap/contexte sont resolus et injectes dans le rapport du prompt systeme.
- Un verrou d’ecriture de session est acquis ; `SessionManager` est ouvert et prepare avant le streaming.

## Assemblage du prompt + prompt systeme

- Le prompt systeme est construit a partir du prompt de base d’OpenClaw, du prompt des Skills, du contexte de bootstrap et des surcharges par execution.
- Les limites specifiques au modele et les jetons reserves pour la compaction sont appliquees.
- Voir [System prompt](/concepts/system-prompt) pour ce que voit le modele.

## Points d’accroche (ou vous pouvez intercepter)

OpenClaw dispose de deux systemes d’accroche :

- **Accroches internes** (accroches de la Gateway) : scripts bases sur des evenements pour les commandes et les evenements de cycle de vie.
- **Accroches de plugins** : points d’extension dans le cycle de vie agent/outils et le pipeline de la gateway.

### Accroches internes (accroches de la Gateway)

- **`agent:bootstrap`** : s’execute pendant la construction des fichiers de bootstrap avant la finalisation du prompt systeme.
  A utiliser pour ajouter/supprimer des fichiers de contexte de bootstrap.
- **Accroches de commandes** : `/new`, `/reset`, `/stop` et autres evenements de commande (voir la doc Hooks).

Voir [Hooks](/hooks) pour la configuration et des exemples.

### Accroches de plugins (cycle de vie agent + gateway)

Elles s’executent dans la boucle d’agent ou le pipeline de la gateway :

- **`before_agent_start`** : injecte du contexte ou surcharge le prompt systeme avant le debut de l’execution.
- **`agent_end`** : inspecte la liste finale des messages et les metadonnees d’execution apres l’achevement.
- **`before_compaction` / `after_compaction`** : observer ou annoter les cycles de compaction.
- **`before_tool_call` / `after_tool_call`** : intercepter les parametres/resultats d’outils.
- **`tool_result_persist`** : transformer de maniere synchrone les resultats d’outils avant leur ecriture dans la transcription de session.
- **`message_received` / `message_sending` / `message_sent`** : accroches de messages entrants + sortants.
- **`session_start` / `session_end`** : frontieres du cycle de vie de session.
- **`gateway_start` / `gateway_stop`** : evenements du cycle de vie de la gateway.

Voir [Plugins](/plugin#plugin-hooks) pour l’API des accroches et les details d’enregistrement.

## Streaming + reponses partielles

- Les deltas assistant sont diffuses depuis pi-agent-core et emis comme des evenements `assistant`.
- Le streaming par blocs peut emettre des reponses partielles soit sur `text_end`, soit sur `message_end`.
- Le streaming du raisonnement peut etre emis comme un flux separe ou comme des reponses par blocs.
- Voir [Streaming](/concepts/streaming) pour le decoupage et le comportement des reponses par blocs.

## Execution d’outils + outils de messagerie

- Les evenements de debut/mise a jour/fin d’outils sont emis sur le flux `tool`.
- Les resultats d’outils sont assainis (taille et charges utiles d’images) avant journalisation/emission.
- Les envois via les outils de messagerie sont suivis afin de supprimer les confirmations d’assistant en double.

## Mise en forme des reponses + suppression

- Les charges utiles finales sont assemblees a partir de :
  - texte de l’assistant (et raisonnement optionnel)
  - resumes d’outils en ligne (lorsque verbose + autorise)
  - texte d’erreur de l’assistant lorsque le modele echoue
- `NO_REPLY` est traite comme un jeton silencieux et filtre des charges utiles sortantes.
- Les doublons des outils de messagerie sont supprimes de la liste finale des charges utiles.
- S’il ne reste aucune charge utile rendable et qu’un outil a echoue, une reponse d’erreur d’outil de secours est emise
  (sauf si un outil de messagerie a deja envoye une reponse visible par l’utilisateur).

## Compaction + nouvelles tentatives

- La compaction automatique emet des evenements de flux `compaction` et peut declencher une nouvelle tentative.
- Lors d’une nouvelle tentative, les tampons en memoire et les resumes d’outils sont reinitialises pour eviter les sorties dupliquees.
- Voir [Compaction](/concepts/compaction) pour le pipeline de compaction.

## Flux d’evenements (aujourd’hui)

- `lifecycle` : emis par `subscribeEmbeddedPiSession` (et en secours par `agentCommand`)
- `assistant` : deltas diffuses depuis pi-agent-core
- `tool` : evenements d’outils diffuses depuis pi-agent-core

## Gestion des canaux de chat

- Les deltas assistant sont mis en tampon dans des messages de chat `delta`.
- Un message de chat `final` est emis a la **fin/erreur de cycle de vie**.

## Delais d’expiration

- Valeur par defaut `agent.wait` : 30 s (attente uniquement). Le parametre `timeoutMs` surcharge.
- Runtime de l’agent : valeur par defaut `agents.defaults.timeoutSeconds` de 600 s ; appliquee dans le minuteur d’abandon `runEmbeddedPiAgent`.

## Là où les choses peuvent se terminer tôt

- Delai d’expiration de l’agent (abandon)
- AbortSignal (annulation)
- Deconnexion de la Gateway ou delai d’expiration RPC
- Delai d’expiration `agent.wait` (attente uniquement, n’arrete pas l’agent)
