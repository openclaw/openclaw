---
summary: "Tâches cron + réveils pour le planificateur de passerelle"
read_when:
  - Planifier des tâches de fond ou des réveils
  - Câbler une automatisation qui devrait s'exécuter avec ou à côté des heartbeats
  - Décider entre heartbeat et cron pour les tâches planifiées
title: "Tâches cron"
---

# Tâches cron (planificateur de passerelle)

> **Cron vs Heartbeat ?** Voir [Cron vs Heartbeat](/fr-FR/automation/cron-vs-heartbeat) pour des conseils sur quand utiliser chacun.

Cron est le planificateur intégré de la Passerelle. Il persiste les tâches, réveille l'agent au
bon moment, et peut optionnellement livrer la sortie vers un chat.

Si vous voulez _"exécuter ceci chaque matin"_ ou _"stimuler l'agent dans 20 minutes"_,
cron est le mécanisme.

Dépannage : [/automation/troubleshooting](/fr-FR/automation/troubleshooting)

## TL;DR

- Cron s'exécute **à l'intérieur de la Passerelle** (pas à l'intérieur du modèle).
- Les tâches persistent sous `~/.openclaw/cron/` donc les redémarrages ne perdent pas les planifications.
- Deux styles d'exécution :
  - **Session principale** : met en file d'attente un événement système, puis s'exécute au prochain heartbeat.
  - **Isolée** : exécute un tour d'agent dédié dans `cron:<jobId>`, avec livraison (annonce par défaut ou aucune).
- Les réveils sont de première classe : une tâche peut demander "réveille maintenant" vs "prochain heartbeat".

## Démarrage rapide (actionnable)

Créez un rappel unique, vérifiez qu'il existe et exécutez-le immédiatement :

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

Planifiez une tâche isolée récurrente avec livraison :

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Équivalents d'appel d'outil (outil cron de passerelle)

Pour les formes JSON canoniques et les exemples, voir [Schéma JSON pour les appels d'outils](/fr-FR/automation/cron-jobs#json-schema-for-tool-calls).

## Où les tâches cron sont stockées

Les tâches cron sont persistées sur l'hôte de passerelle à `~/.openclaw/cron/jobs.json` par défaut.
La Passerelle charge le fichier en mémoire et le réécrit lors des changements, donc les modifications manuelles
sont uniquement sûres quand la Passerelle est arrêtée. Préférez `openclaw cron add/edit` ou l'API
d'appel d'outil cron pour les changements.

## Vue d'ensemble conviviale pour débutants

Pensez à une tâche cron comme : **quand** exécuter + **quoi** faire.

1. **Choisir une planification**
   - Rappel unique → `schedule.kind = "at"` (CLI : `--at`)
   - Tâche répétée → `schedule.kind = "every"` ou `schedule.kind = "cron"`
   - Si votre timestamp ISO omet un fuseau horaire, il est traité comme **UTC**.

2. **Choisir où elle s'exécute**
   - `sessionTarget: "main"` → exécute pendant le prochain heartbeat avec le contexte principal.
   - `sessionTarget: "isolated"` → exécute un tour d'agent dédié dans `cron:<jobId>`.

3. **Choisir la charge utile**
   - Session principale → `payload.kind = "systemEvent"`
   - Session isolée → `payload.kind = "agentTurn"`

Optionnel : les tâches uniques (`schedule.kind = "at"`) se suppriment après succès par défaut. Définissez
`deleteAfterRun: false` pour les garder (elles se désactiveront après succès).

## Concepts

### Tâches

Une tâche cron est un enregistrement stocké avec :

- une **planification** (quand elle devrait s'exécuter),
- une **charge utile** (ce qu'elle devrait faire),
- **mode de livraison** optionnel (annonce ou aucune).
- **liaison d'agent** optionnelle (`agentId`) : exécute la tâche sous un agent spécifique ; si
  manquant ou inconnu, la passerelle replie vers l'agent par défaut.

Les tâches sont identifiées par un `jobId` stable (utilisé par les APIs CLI/Passerelle).
Dans les appels d'outils d'agent, `jobId` est canonique ; l'hérité `id` est accepté pour compatibilité.
Les tâches uniques se suppriment automatiquement après succès par défaut ; définissez `deleteAfterRun: false` pour les garder.

### Planifications

Cron supporte trois types de planification :

- `at` : timestamp unique via `schedule.at` (ISO 8601).
- `every` : intervalle fixe (ms).
- `cron` : expression cron 5 champs avec fuseau horaire IANA optionnel.

Les expressions cron utilisent `croner`. Si un fuseau horaire est omis, le fuseau horaire
local de l'hôte de passerelle est utilisé.

### Exécution principale vs isolée

#### Tâches de session principale (événements système)

Les tâches principales mettent en file d'attente un événement système et réveillent optionnellement le runner heartbeat.
Elles doivent utiliser `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (par défaut) : l'événement déclenche une exécution de heartbeat immédiate.
- `wakeMode: "next-heartbeat"` : l'événement attend le prochain heartbeat planifié.

C'est le meilleur choix quand vous voulez l'invite heartbeat normale + le contexte de session principale.
Voir [Heartbeat](/fr-FR/gateway/heartbeat).

#### Tâches isolées (sessions cron dédiées)

Les tâches isolées exécutent un tour d'agent dédié dans la session `cron:<jobId>`.

Comportements clés :

- L'invite est préfixée avec `[cron:<jobId> <nom de tâche>]` pour la traçabilité.
- Chaque exécution démarre un **id de session frais** (pas de report de conversation antérieure).
- Comportement par défaut : si `delivery` est omis, les tâches isolées annoncent un résumé (`delivery.mode = "announce"`).
- `delivery.mode` (isolé uniquement) choisit ce qui se passe :
  - `announce` : livre un résumé au canal cible et poste un bref résumé à la session principale.
  - `none` : interne uniquement (pas de livraison, pas de résumé de session principale).
- `wakeMode` contrôle quand le résumé de session principale poste :
  - `now` : heartbeat immédiat.
  - `next-heartbeat` : attend le prochain heartbeat planifié.

Utilisez les tâches isolées pour des tâches bruyantes, fréquentes ou des "corvées de fond" qui ne devraient pas spammer
votre historique de chat principal.

### Formes de charge utile (ce qui s'exécute)

Deux types de charge utile sont supportés :

- `systemEvent` : session principale uniquement, routé via l'invite heartbeat.
- `agentTurn` : session isolée uniquement, exécute un tour d'agent dédié.

Champs `agentTurn` courants :

- `message` : invite de texte requise.
- `model` / `thinking` : remplacements optionnels (voir ci-dessous).
- `timeoutSeconds` : remplacement de timeout optionnel.

Config de livraison (tâches isolées uniquement) :

- `delivery.mode` : `none` | `announce`.
- `delivery.channel` : `last` ou un canal spécifique.
- `delivery.to` : cible spécifique au canal (téléphone/chat/id de canal).
- `delivery.bestEffort` : évite d'échouer la tâche si la livraison d'annonce échoue.

La livraison d'annonce supprime les envois d'outils de messagerie pour l'exécution ; utilisez `delivery.channel`/`delivery.to`
pour cibler le chat à la place. Quand `delivery.mode = "none"`, aucun résumé n'est posté à la session principale.

Si `delivery` est omis pour les tâches isolées, OpenClaw utilise par défaut `announce`.

#### Flux de livraison d'annonce

Quand `delivery.mode = "announce"`, cron livre directement via les adaptateurs de canal sortants.
L'agent principal n'est pas lancé pour créer ou transférer le message.

Détails de comportement :

- Contenu : la livraison utilise les charges utiles sortantes de l'exécution isolée (texte/média) avec découpage normal et
  formatage de canal.
- Les réponses heartbeat uniquement (`HEARTBEAT_OK` sans contenu réel) ne sont pas livrées.
- Si l'exécution isolée a déjà envoyé un message à la même cible via l'outil de message, la livraison est
  sautée pour éviter les doublons.
- Les cibles de livraison manquantes ou invalides échouent la tâche sauf si `delivery.bestEffort = true`.
- Un court résumé est posté à la session principale uniquement quand `delivery.mode = "announce"`.
- Le résumé de session principale respecte `wakeMode` : `now` déclenche un heartbeat immédiat et
  `next-heartbeat` attend le prochain heartbeat planifié.

### Remplacements de modèle et thinking

Les tâches isolées (`agentTurn`) peuvent remplacer le modèle et le niveau de thinking :

- `model` : Chaîne fournisseur/modèle (ex., `anthropic/claude-sonnet-4-20250514`) ou alias (ex., `opus`)
- `thinking` : Niveau de thinking (`off`, `minimal`, `low`, `medium`, `high`, `xhigh` ; modèles GPT-5.2 + Codex uniquement)

Note : Vous pouvez définir `model` sur les tâches de session principale aussi, mais cela change le modèle de session
principale partagé. Nous recommandons les remplacements de modèle uniquement pour les tâches isolées pour éviter
des changements de contexte inattendus.

Priorité de résolution :

1. Remplacement de charge utile de tâche (le plus haut)
2. Valeurs par défaut spécifiques au hook (ex., `hooks.gmail.model`)
3. Valeur par défaut de config d'agent

### Livraison (canal + cible)

Les tâches isolées peuvent livrer la sortie à un canal via la config `delivery` de niveau supérieur :

- `delivery.mode` : `announce` (livre un résumé) ou `none`.
- `delivery.channel` : `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.
- `delivery.to` : cible de destinataire spécifique au canal.

La config de livraison est uniquement valide pour les tâches isolées (`sessionTarget: "isolated"`).

Si `delivery.channel` ou `delivery.to` est omis, cron peut replier vers la "dernière route" de la session principale
(le dernier endroit où l'agent a répondu).

Rappels de format de cible :

- Les cibles Slack/Discord/Mattermost (plugin) devraient utiliser des préfixes explicites (ex. `channel:<id>`, `user:<id>`) pour éviter l'ambiguïté.
- Les sujets Telegram devraient utiliser la forme `:topic:` (voir ci-dessous).

#### Cibles de livraison Telegram (sujets / fils de forum)

Telegram supporte les sujets de forum via `message_thread_id`. Pour la livraison cron, vous pouvez encoder
le sujet/fil dans le champ `to` :

- `-1001234567890` (id de chat uniquement)
- `-1001234567890:topic:123` (préféré : marqueur de sujet explicite)
- `-1001234567890:123` (raccourci : suffixe numérique)

Les cibles préfixées comme `telegram:...` / `telegram:group:...` sont aussi acceptées :

- `telegram:group:-1001234567890:topic:123`

## Schéma JSON pour les appels d'outils

Utilisez ces formes lors de l'appel direct des outils `cron.*` de passerelle (appels d'outils d'agent ou RPC).
Les flags CLI acceptent des durées humaines comme `20m`, mais les appels d'outils devraient utiliser une chaîne ISO 8601
pour `schedule.at` et des millisecondes pour `schedule.everyMs`.

### Paramètres cron.add

Tâche unique, session principale (événement système) :

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

Tâche récurrente, isolée avec livraison :

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

Notes :

- `schedule.kind` : `at` (`at`), `every` (`everyMs`), ou `cron` (`expr`, `tz` optionnel).
- `schedule.at` accepte ISO 8601 (fuseau horaire optionnel ; traité comme UTC quand omis).
- `everyMs` est en millisecondes.
- `sessionTarget` doit être `"main"` ou `"isolated"` et doit correspondre à `payload.kind`.
- Champs optionnels : `agentId`, `description`, `enabled`, `deleteAfterRun` (par défaut true pour `at`),
  `delivery`.
- `wakeMode` utilise par défaut `"now"` quand omis.

### Paramètres cron.update

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

Notes :

- `jobId` est canonique ; `id` est accepté pour compatibilité.
- Utilisez `agentId: null` dans le patch pour effacer une liaison d'agent.

### Paramètres cron.run et cron.remove

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Stockage et historique

- Magasin de tâches : `~/.openclaw/cron/jobs.json` (JSON géré par la passerelle).
- Historique d'exécution : `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, auto-élagué).
- Remplacer le chemin de magasin : `cron.store` dans la config.

## Configuration

```json5
{
  cron: {
    enabled: true, // par défaut true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // par défaut 1
  },
}
```

Désactiver cron entièrement :

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## Démarrage rapide CLI

Rappel unique (ISO UTC, suppression automatique après succès) :

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Rappel unique (session principale, réveil immédiat) :

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Tâche isolée récurrente (annonce vers WhatsApp) :

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Tâche isolée récurrente (livre vers un sujet Telegram) :

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Tâche isolée avec remplacement de modèle et thinking :

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Sélection d'agent (configurations multi-agents) :

```bash
# Épingle une tâche à l'agent "ops" (repli vers défaut si cet agent est manquant)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Change ou efface l'agent sur une tâche existante
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Exécution manuelle (force est le défaut, utilisez `--due` pour exécuter uniquement quand dû) :

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Éditer une tâche existante (patcher des champs) :

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Historique d'exécution :

```bash
openclaw cron runs --id <jobId> --limit 50
```

Événement système immédiat sans créer de tâche :

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Surface API de passerelle

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force ou dû), `cron.runs`
  Pour les événements système immédiats sans tâche, utilisez [`openclaw system event`](/fr-FR/cli/system).

## Dépannage

### "Rien ne s'exécute"

- Vérifiez que cron est activé : `cron.enabled` et `OPENCLAW_SKIP_CRON`.
- Vérifiez que la Passerelle s'exécute en continu (cron s'exécute à l'intérieur du processus de passerelle).
- Pour les planifications `cron` : confirmez le fuseau horaire (`--tz`) vs le fuseau horaire hôte.

### Une tâche récurrente continue de retarder après des échecs

- OpenClaw applique un backoff de réessai exponentiel pour les tâches récurrentes après des erreurs consécutives :
  30s, 1m, 5m, 15m, puis 60m entre les réessais.
- Le backoff se réinitialise automatiquement après la prochaine exécution réussie.
- Les tâches uniques (`at`) se désactivent après une exécution terminale (`ok`, `error`, ou `skipped`) et ne réessaient pas.

### Telegram livre au mauvais endroit

- Pour les sujets de forum, utilisez `-100…:topic:<id>` pour que ce soit explicite et sans ambiguïté.
- Si vous voyez des préfixes `telegram:...` dans les journaux ou les cibles de "dernière route" stockées, c'est normal ;
  la livraison cron les accepte et analyse toujours les IDs de sujet correctement.
