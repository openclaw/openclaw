---
summary: "Outils de session d’agent pour lister les sessions, recuperer l’historique et envoyer des messages inter‑sessions"
read_when:
  - Ajout ou modification des outils de session
title: "Outils de session"
---

# Outils de session

Objectif : un ensemble d’outils réduit et difficile a mal utiliser afin que les agents puissent lister les sessions, recuperer l’historique et envoyer des messages vers une autre session.

## Noms des outils

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Modèle de clé

- Le compartiment de discussion directe principal est toujours la cle litterale `"main"` (resolue vers la cle principale de l’agent courant).
- Les discussions de groupe utilisent `agent:<agentId>:<channel>:group:<id>` ou `agent:<agentId>:<channel>:channel:<id>` (fournir la cle complete).
- Les taches cron utilisent `cron:<job.id>`.
- Les hooks utilisent `hook:<uuid>` sauf configuration explicite.
- Les sessions Node utilisent `node-<nodeId>` sauf configuration explicite.

`global` et `unknown` sont des valeurs reservees et ne sont jamais listees. Si `session.scope = "global"`, nous l’aliasons vers `main` pour tous les outils afin que les appelants ne voient jamais `global`.

## sessions_list

Lister les sessions sous forme d’un tableau de lignes.

Parametres :

- filtre `kinds?: string[]` : l’un de `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` nombre maximal de lignes (defaut : defaut serveur, limite p. ex. 200)
- `activeMinutes?: number` uniquement les sessions mises a jour dans les N dernieres minutes
- `messageLimit?: number` 0 = aucun message (defaut 0) ; >0 = inclure les N derniers messages

Comportement :

- `messageLimit > 0` recupere `chat.history` par session et inclut les N derniers messages.
- Les resultats d’outils sont filtres dans la sortie de liste ; utilisez `sessions_history` pour les messages d’outil.
- Lorsqu’elle s’execute dans une session d’agent **en sandbox**, les outils de session adoptent par defaut une **visibilite limitee aux sessions engendrees** (voir ci‑dessous).

Forme d’une ligne (JSON) :

- `key` : cle de session (string)
- `kind` : `main | group | cron | hook | node | other`
- `channel` : `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (libelle d’affichage de groupe si disponible)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (surcharge de session si definie)
- `lastChannel`, `lastTo`
- `deliveryContext` (`{ channel, to, accountId }` normalise lorsque disponible)
- `transcriptPath` (chemin « best‑effort » derive du repertoire de stockage + sessionId)
- `messages?` (uniquement lorsque `messageLimit > 0`)

## sessions_history

Recuperer la transcription d’une session.

Parametres :

- `sessionKey` (requis ; accepte une cle de session ou `sessionId` depuis `sessions_list`)
- `limit?: number` nombre maximal de messages (limite par le serveur)
- `includeTools?: boolean` (defaut false)

Comportement :

- `includeTools=false` filtre les messages `role: "toolResult"`.
- Retourne un tableau de messages au format brut de transcription.
- Lorsqu’un `sessionId` est fourni, OpenClaw le resout vers la cle de session correspondante (erreur si identifiants manquants).

## sessions_send

Envoyer un message dans une autre session.

Parametres :

- `sessionKey` (requis ; accepte une cle de session ou `sessionId` depuis `sessions_list`)
- `message` (requis)
- `timeoutSeconds?: number` (defaut >0 ; 0 = fire‑and‑forget)

Comportement :

- `timeoutSeconds = 0` : met en file d’attente et retourne `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0` : attend jusqu’a N secondes l’achevement, puis retourne `{ runId, status: "ok", reply }`.
- Si l’attente expire : `{ runId, status: "timeout", error }`. L’execution continue ; appelez `sessions_history` plus tard.
- Si l’execution echoue : `{ runId, status: "error", error }`.
- Les executions d’annonce de livraison sont lancees apres l’execution principale et sont « best‑effort » ; `status: "ok"` ne garantit pas que l’annonce a ete livree.
- L’attente passe par la Gateway (passerelle) `agent.wait` (cote serveur) afin que les reconnexions n’interrompent pas l’attente.
- Le contexte de message agent‑a‑agent est injecte pour l’execution principale.
- Apres l’achevement de l’execution principale, OpenClaw lance une **boucle de reponse‑retour** :
  - Les tours 2+ alternent entre l’agent demandeur et l’agent cible.
  - Repondez exactement `REPLY_SKIP` pour arreter le ping‑pong.
  - Le nombre maximal de tours est `session.agentToAgent.maxPingPongTurns` (0–5, defaut 5).
- Une fois la boucle terminee, OpenClaw lance l’**etape d’annonce agent‑a‑agent** (agent cible uniquement) :
  - Repondez exactement `ANNOUNCE_SKIP` pour rester silencieux.
  - Toute autre reponse est envoyee au canal cible.
  - L’etape d’annonce inclut la demande originale + la reponse du tour 1 + la derniere reponse de ping‑pong.

## Champ Channel

- Pour les groupes, `channel` est le canal enregistre sur l’entree de session.
- Pour les discussions directes, `channel` est mappe depuis `lastChannel`.
- Pour cron/hook/node, `channel` est `internal`.
- S’il est manquant, `channel` est `unknown`.

## Securite / Politique d’envoi

Blocage base sur des politiques par canal/type de discussion (pas par identifiant de session).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Surcharge a l’execution (par entree de session) :

- `sendPolicy: "allow" | "deny"` (non defini = herite de la configuration)
- Definissable via `sessions.patch` ou `/send on|off|inherit` reserve au proprietaire (message autonome).

Points d’application :

- `chat.send` / `agent` (Gateway)
- logique de livraison des reponses automatiques

## sessions_spawn

Lancer l’execution d’un sous‑agent dans une session isolee et annoncer le resultat au canal de discussion du demandeur.

Parametres :

- `task` (requis)
- `label?` (optionnel ; utilise pour les logs/UI)
- `agentId?` (optionnel ; lancer sous un autre identifiant d’agent si autorise)
- `model?` (optionnel ; remplace le modele du sous‑agent ; valeurs invalides = erreur)
- `runTimeoutSeconds?` (defaut 0 ; si defini, interrompt l’execution du sous‑agent apres N secondes)
- `cleanup?` (`delete|keep`, defaut `keep`)

Liste d’autorisation :

- `agents.list[].subagents.allowAgents` : liste des identifiants d’agent autorises via `agentId` (`["*"]` pour autoriser tous). Defaut : uniquement l’agent demandeur.

Decouverte :

- Utilisez `agents_list` pour decouvrir quels identifiants d’agent sont autorises pour `sessions_spawn`.

Comportement :

- Demarre une nouvelle session `agent:<agentId>:subagent:<uuid>` avec `deliver: false`.
- Les sous‑agents disposent par defaut de l’ensemble complet d’outils **moins les outils de session** (configurable via `tools.subagents.tools`).
- Les sous‑agents ne sont pas autorises a appeler `sessions_spawn` (pas de sous‑agent → lancement de sous‑agent).
- Toujours non bloquant : retourne immediatement `{ status: "accepted", runId, childSessionKey }`.
- Apres l’achevement, OpenClaw lance une **etape d’annonce** du sous‑agent et publie le resultat dans le canal de discussion du demandeur.
- Repondez exactement `ANNOUNCE_SKIP` pendant l’etape d’annonce pour rester silencieux.
- Les reponses d’annonce sont normalisees en `Status`/`Result`/`Notes` ; `Status` provient du resultat a l’execution (pas du texte du modele).
- Les sessions de sous‑agent sont archivees automatiquement apres `agents.defaults.subagents.archiveAfterMinutes` (defaut : 60).
- Les reponses d’annonce incluent une ligne de statistiques (duree d’execution, tokens, sessionKey/sessionId, chemin de transcription et cout optionnel).

## Visibilite des sessions en sandbox

Les sessions en sandbox peuvent utiliser les outils de session, mais par defaut elles ne voient que les sessions qu’elles ont engendrees via `sessions_spawn`.

Configuration :

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
