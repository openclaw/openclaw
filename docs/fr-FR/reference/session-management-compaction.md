---
summary: "Deep dive : store session + transcripts, lifecycle et internals (auto)compaction"
read_when:
  - Vous devez déboguer ids session, transcript JSONL ou champs sessions.json
  - Vous changez comportement auto-compaction ou ajoutez housekeeping "pré-compaction"
  - Vous voulez implémenter flushes mémoire ou turns système silencieux
title: "Deep Dive Gestion Session"
---

# Gestion Session & Compaction (Deep Dive)

Ce document explique comment OpenClaw gère sessions end-to-end :

- **Routing session** (comment messages inbound mappent vers `sessionKey`)
- **Store session** (`sessions.json`) et ce qu'il track
- **Persistance transcript** (`*.jsonl`) et sa structure
- **Hygiène transcript** (fixups spécifiques provider avant runs)
- **Limites contexte** (fenêtre contexte vs tokens trackés)
- **Compaction** (manuelle + auto-compaction) et où hooker travail pré-compaction
- **Housekeeping silencieux** (ex : écritures mémoire qui ne devraient pas produire output visible user)

Si vous voulez overview haut niveau d'abord, commencez avec :

- [/fr-FR/concepts/session](/fr-FR/concepts/session)
- [/fr-FR/concepts/compaction](/fr-FR/concepts/compaction)
- [/fr-FR/concepts/session-pruning](/fr-FR/concepts/session-pruning)
- [/fr-FR/reference/transcript-hygiene](/fr-FR/reference/transcript-hygiene)

---

## Source vérité : Passerelle

OpenClaw designé autour **processus Passerelle unique** qui possède état session.

- UIs (app macOS, Control UI web, TUI) devraient requêter Passerelle pour listes session et counts token.
- En mode distant, fichiers session sur host distant ; "vérifier vos fichiers Mac locaux" ne reflétera pas ce qu'utilise Passerelle.

---

## Deux couches persistance

OpenClaw persiste sessions en deux couches :

1. **Store session (`sessions.json`)**
   - Map clé/valeur : `sessionKey -> SessionEntry`
   - Petit, mutable, sûr éditer (ou supprimer entrées)
   - Track metadata session (id session actuel, activité dernière, toggles, compteurs token, etc.)

2. **Transcript (`<sessionId>.jsonl`)**
   - Transcript append-only avec structure arbre (entrées ont `id` + `parentId`)
   - Stocke conversation réelle + appels tool + résumés compaction
   - Utilisé pour rebuild contexte modèle pour turns futurs

---

## Emplacements sur disque

Per agent, sur host Passerelle :

- Store : `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transcripts : `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Sessions topic Telegram : `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw résout via `src/config/sessions.ts`.

---

## Clés session (`sessionKey`)

`sessionKey` identifie _quel bucket conversation_ vous êtes dans (routing + isolation).

Patterns communs :

- Main/chat direct (per agent) : `agent:<agentId>:<mainKey>` (défaut `main`)
- Groupe : `agent:<agentId>:<channel>:group:<id>`
- Room/channel (Discord/Slack) : `agent:<agentId>:<channel>:channel:<id>` ou `...:room:<id>`
- Cron : `cron:<job.id>`
- Webhook : `hook:<uuid>` (sauf override)

Règles canoniques documentées à [/fr-FR/concepts/session](/fr-FR/concepts/session).

---

## IDs session (`sessionId`)

Chaque `sessionKey` pointe vers `sessionId` actuel (fichier transcript qui continue conversation).

Règles pouce :

- **Reset** (`/new`, `/reset`) crée nouveau `sessionId` pour ce `sessionKey`.
- **Reset quotidien** (défaut 4:00 AM temps local sur host passerelle) crée nouveau `sessionId` sur prochain message après limite reset.
- **Expiry idle** (`session.reset.idleMinutes` ou legacy `session.idleMinutes`) crée nouveau `sessionId` quand message arrive après fenêtre idle. Quand quotidien + idle configurés tous deux, premier expiré gagne.

Détail implémentation : décision arrive dans `initSessionState()` dans `src/auto-reply/reply/session.ts`.

---

## Schéma store session (`sessions.json`)

Type valeur store est `SessionEntry` dans `src/config/sessions.ts`.

Champs clés :

- `sessionKey` : identifiant session
- `sessionId` : ID transcript actuel
- `updatedAt` : timestamp dernière activité
- `model` : modèle configuré session
- `thinkingLevel` : niveau thinking actuel
- `verboseLevel` : niveau verbose actuel
- `totalTokens` : compteur tokens cumulatif
- `contextTokens` : tokens dans contexte actuel
- `compactionCount` : nombre compactions effectuées

---

## Structure transcript JSONL

Chaque ligne fichier `<sessionId>.jsonl` est entrée JSON :

```json
{"id":"msg-001","parentId":null,"role":"user","content":"Bonjour"}
{"id":"msg-002","parentId":"msg-001","role":"assistant","content":"Salut!"}
{"id":"msg-003","parentId":"msg-002","role":"toolCall","name":"exec","input":{...}}
{"id":"msg-004","parentId":"msg-003","role":"toolResult","output":{...}}
```

Structure arbre permet :

- Branches conversation multiples
- Compaction selective
- Rebuild contexte efficient

---

## Auto-compaction

Déclenchée quand :

1. Session approche limite contexte modèle
2. `compaction.mode` est `"auto"`
3. Historique session a suffisamment messages pour compacter

Flux :

1. Optionnel : flush mémoire silencieux (écrire notes durables)
2. Sélectionner messages à compacter (anciens, hors cutoff)
3. Générer résumé compaction via LLM
4. Écrire entrée compaction dans transcript
5. Mettre à jour compteurs session

Configuration :

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "auto",
        targetTokens: 4000,
        reserveTokens: 2000,
      },
    },
  },
}
```

---

## Hooks pré-compaction

Avant compaction, OpenClaw peut exécuter hooks pour housekeeping :

- `agent:pre-compaction` : hook custom exécuté avant résumé généré
- Flush mémoire : écrire notes importantes avant résumé

Exemple hook :

```javascript
// hooks/pre-compaction.js
module.exports = async (ctx) => {
  // Sauvegarder contexte important
  await ctx.memory.flush();
  return { ok: true };
};
```

Voir aussi :

- [Compaction](/fr-FR/concepts/compaction)
- [Sessions](/fr-FR/concepts/sessions)
- [Mémoire](/fr-FR/concepts/memory)
- [Hooks](/fr-FR/automation/hooks)
