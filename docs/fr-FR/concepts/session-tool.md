---
summary: "Outils de session d'agent pour lister les sessions, récupérer l'historique et envoyer des messages inter-sessions"
read_when:
  - Ajouter ou modifier les outils de session
title: "Outils de session"
---

# Outils de session

Objectif : ensemble d'outils petit, difficile à mal utiliser pour que les agents puissent lister les sessions, récupérer l'historique et envoyer vers une autre session.

## Noms d'outils

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Modèle de clé

- Le bucket de chat direct principal est toujours la clé littérale `"main"` (résolu vers la clé principale de l'agent actuel).
- Les chats de groupe utilisent `agent:<agentId>:<channel>:group:<id>` ou `agent:<agentId>:<channel>:channel:<id>` (passez la clé complète).
- Les tâches cron utilisent `cron:<job.id>`.
- Les hooks utilisent `hook:<uuid>` sauf si explicitement défini.
- Les sessions de nœud utilisent `node-<nodeId>` sauf si explicitement défini.

`global` et `unknown` sont des valeurs réservées et ne sont jamais listés. Si `session.scope = "global"`, nous l'alisons vers `main` pour tous les outils donc les appelants ne voient jamais `global`.

## sessions_list

Liste les sessions comme un tableau de lignes.

Paramètres :

- `kinds?: string[]` filtre : n'importe lequel de `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` lignes max (par défaut : défaut serveur, plafond ex. 200)
- `activeMinutes?: number` uniquement les sessions mises à jour dans les N minutes
- `messageLimit?: number` 0 = pas de messages (par défaut 0) ; >0 = inclure les N derniers messages

Comportement :

- `messageLimit > 0` récupère `chat.history` par session et inclut les N derniers messages.
- Les résultats d'outils sont filtrés dans la sortie de liste ; utilisez `sessions_history` pour les messages d'outil.
- Lors de l'exécution dans une session d'agent **en sandbox**, les outils de session par défaut ont une **visibilité spawned-only** (voir ci-dessous).

Forme de ligne (JSON) :

- `key` : clé de session (string)
- `kind` : `main | group | cron | hook | node | other`
- `channel` : `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (étiquette d'affichage de groupe si disponible)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (remplacement de session si défini)
- `lastChannel`, `lastTo`
- `deliveryContext` (normalisé `{ channel, to, accountId }` quand disponible)
- `transcriptPath` (chemin au mieux de l'effort dérivé du répertoire de magasin + sessionId)
- `messages?` (uniquement quand `messageLimit > 0`)

## sessions_history

Récupère la transcription pour une session.

Paramètres :

- `sessionKey` (requis ; accepte clé de session ou `sessionId` de `sessions_list`)
- `limit?: number` messages max (plafond serveur)
- `includeTools?: boolean` (par défaut false)

Comportement :

- `includeTools=false` filtre les messages `role: "toolResult"`.
- Retourne un tableau de messages dans le format brut de transcription.
- Quand donné un `sessionId`, OpenClaw le résout vers la clé de session correspondante (ids manquants erreur).

## sessions_send

Envoie un message dans une autre session.

Paramètres :

- `sessionKey` (requis ; accepte clé de session ou `sessionId` de `sessions_list`)
- `message` (requis)
- `timeoutSeconds?: number` (par défaut >0 ; 0 = fire-and-forget)

Comportement :

- `timeoutSeconds = 0` : met en file d'attente et retourne `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0` : attend jusqu'à N secondes pour achèvement, puis retourne `{ runId, status: "ok", reply }`.
- Si l'attente timeout : `{ runId, status: "timeout", error }`. L'exécution continue ; appelez `sessions_history` plus tard.
- Si l'exécution échoue : `{ runId, status: "error", error }`.
- L'annonce de livraison s'exécute après que l'exécution primaire se termine et est au mieux de l'effort ; `status: "ok"` ne garantit pas que l'annonce a été livrée.
- Attend via gateway `agent.wait` (côté serveur) donc les reconnexions ne laissent pas tomber l'attente.
- Le contexte de message agent-à-agent est injecté pour l'exécution primaire.
- Les messages inter-sessions sont persistés avec `message.provenance.kind = "inter_session"` donc les lecteurs de transcription peuvent distinguer les instructions d'agent routées de l'entrée utilisateur externe.
- Après que l'exécution primaire se termine, OpenClaw exécute une **boucle de réponse-retour** :
  - Le tour 2+ alterne entre les agents demandeur et cible.
  - Répondez exactement `REPLY_SKIP` pour arrêter le ping-pong.
  - Les tours max sont `session.agentToAgent.maxPingPongTurns` (0–5, par défaut 5).
- Une fois que la boucle se termine, OpenClaw exécute l'**étape d'annonce agent-à-agent** (agent cible uniquement) :
  - Répondez exactement `ANNOUNCE_SKIP` pour rester silencieux.
  - Toute autre réponse est envoyée au canal cible.
  - L'étape d'annonce inclut la requête originale + réponse tour-1 + dernière réponse ping-pong.

## Champ de canal

- Pour les groupes, `channel` est le canal enregistré sur l'entrée de session.
- Pour les chats directs, `channel` mappe depuis `lastChannel`.
- Pour cron/hook/node, `channel` est `internal`.
- Si manquant, `channel` est `unknown`.

## Sécurité / Politique d'envoi

Blocage basé sur politique par canal/type de chat (pas par id de session).

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

Remplacement d'exécution (par entrée de session) :

- `sendPolicy: "allow" | "deny"` (non défini = hériter config)
- Définissable via `sessions.patch` ou propriétaire uniquement `/send on|off|inherit` (message autonome).

Points d'application :

- `chat.send` / `agent` (passerelle)
- logique de livraison de réponse automatique

## sessions_spawn

Génère une exécution de sous-agent dans une session isolée et annonce le résultat de retour au canal de chat demandeur.

Paramètres :

- `task` (requis)
- `label?` (optionnel ; utilisé pour les journaux/UI)
- `agentId?` (optionnel ; génère sous un autre id d'agent si autorisé)
- `model?` (optionnel ; remplace le modèle de sous-agent ; valeurs invalides erreur)
- `runTimeoutSeconds?` (par défaut 0 ; quand défini, abandonne l'exécution de sous-agent après N secondes)
- `cleanup?` (`delete|keep`, par défaut `keep`)

Liste blanche :

- `agents.list[].subagents.allowAgents` : liste d'ids d'agent autorisés via `agentId` (`["*"]` pour autoriser tous). Par défaut : uniquement l'agent demandeur.

Découverte :

- Utilisez `agents_list` pour découvrir quels ids d'agent sont autorisés pour `sessions_spawn`.

Comportement :

- Démarre une nouvelle session `agent:<agentId>:subagent:<uuid>` avec `deliver: false`.
- Les sous-agents par défaut ont l'ensemble d'outils complet **moins les outils de session** (configurable via `tools.subagents.tools`).
- Les sous-agents ne sont pas autorisés à appeler `sessions_spawn` (pas de génération sous-agent → sous-agent).
- Toujours non bloquant : retourne `{ status: "accepted", runId, childSessionKey }` immédiatement.
- Après achèvement, OpenClaw exécute une **étape d'annonce de sous-agent** et poste le résultat au canal de chat demandeur.
- Répondez exactement `ANNOUNCE_SKIP` pendant l'étape d'annonce pour rester silencieux.
- Les réponses d'annonce sont normalisées en `Status`/`Result`/`Notes` ; `Status` vient du résultat d'exécution (pas du texte du modèle).
- Les sessions de sous-agent sont auto-archivées après `agents.defaults.subagents.archiveAfterMinutes` (par défaut : 60).
- Les réponses d'annonce incluent une ligne de stats (exécution, jetons, sessionKey/sessionId, chemin de transcription, et coût optionnel).

## Visibilité de session en sandbox

Les sessions en sandbox peuvent utiliser les outils de session, mais par défaut elles ne voient que les sessions qu'elles ont générées via `sessions_spawn`.

Config :

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // défaut: "spawned"
        sessionToolsVisibility: "spawned", // ou "all"
      },
    },
  },
}
```
