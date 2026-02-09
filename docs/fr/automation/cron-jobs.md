---
summary: "Tâches cron + réveils pour le planificateur du Gateway"
read_when:
  - Planifier des tâches d’arrière-plan ou des réveils
  - Câbler des automatisations qui doivent s’exécuter avec ou en parallèle des heartbeats
  - Choisir entre heartbeat et cron pour les tâches planifiées
title: "Tâches Cron"
---

# Tâches cron (planificateur du Gateway)

> **Cron vs Heartbeat ?** Voir [Cron vs Heartbeat](/automation/cron-vs-heartbeat) pour savoir quand utiliser chacun.

Cron est le planificateur intégré du Gateway. Il persiste les tâches, réveille l’agent
au bon moment et peut, en option, renvoyer la sortie vers un chat.

Si vous voulez _« exécuter ceci chaque matin »_ ou _« réveiller l’agent dans 20 minutes »_,
cron est le mécanisme adapté.

Dépannage : [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron s’exécute **à l’intérieur du Gateway** (pas à l’intérieur du modèle).
- Les tâches persistent sous `~/.openclaw/cron/` afin que les redémarrages ne fassent pas perdre les planifications.
- Deux styles d’exécution :
  - **Session principale** : met en file d’attente un événement système, puis s’exécute au prochain heartbeat.
  - **Isolé** : exécute un tour d’agent dédié dans `cron:<jobId>`, avec livraison (annonce par défaut ou aucune).
- Les réveils sont de première classe : une tâche peut demander « réveiller maintenant » plutôt que « prochain heartbeat ».

## Demarrage rapide (actionnable)

Créer un rappel ponctuel, vérifier qu’il existe et l’exécuter immédiatement :

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id> --force
openclaw cron runs --id <job-id>
```

Planifier une tâche isolée récurrente avec livraison :

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

## Équivalents d’appel d’outil (outil cron du Gateway)

Pour les formes JSON canoniques et les exemples, voir [Schéma JSON pour les appels d’outil](/automation/cron-jobs#json-schema-for-tool-calls).

## Où sont stockées les tâches cron

Les tâches cron sont persistées sur l’hôte du Gateway par défaut à `~/.openclaw/cron/jobs.json`.
Le Gateway charge le fichier en mémoire et le réécrit lors des modifications ; les éditions manuelles
ne sont donc sûres que lorsque le Gateway est arrêté. Préférez `openclaw cron add/edit` ou l’API
d’appel d’outil cron pour les changements.

## Présentation pour débutants

Pensez à une tâche cron comme : **quand** s’exécuter + **quoi** faire.

1. **Choisir une planification**
   - Rappel ponctuel → `schedule.kind = "at"` (CLI : `--at`)
   - Tâche répétée → `schedule.kind = "every"` ou `schedule.kind = "cron"`
   - Si votre horodatage ISO omet un fuseau horaire, il est traité comme **UTC**.

2. **Choisir où elle s’exécute**
   - `sessionTarget: "main"` → s’exécute lors du prochain heartbeat avec le contexte principal.
   - `sessionTarget: "isolated"` → exécute un tour d’agent dédié dans `cron:<jobId>`.

3. **Choisir la charge utile**
   - Session principale → `payload.kind = "systemEvent"`
   - Session isolée → `payload.kind = "agentTurn"`

Optionnel : les tâches ponctuelles (`schedule.kind = "at"`) se suppriment après succès par défaut. Définissez
`deleteAfterRun: false` pour les conserver (elles se désactiveront après succès).

## Concepts

### Tâches

Une tâche cron est un enregistrement stocké avec :

- une **planification** (quand elle doit s’exécuter),
- une **charge utile** (ce qu’elle doit faire),
- un **mode de livraison** optionnel (annonce ou aucune),
- une **liaison d’agent** optionnelle (`agentId`) : exécuter la tâche sous un agent spécifique ; si
  absente ou inconnue, le Gateway se rabat sur l’agent par défaut.

Les tâches sont identifiées par un `jobId` stable (utilisé par les API CLI/Gateway).
Dans les appels d’outil de l’agent, `jobId` est canonique ; l’historique `id` est accepté pour compatibilité.
Les tâches ponctuelles se suppriment automatiquement après succès par défaut ; définissez `deleteAfterRun: false` pour les conserver.

### Planifications

Cron prend en charge trois types de planification :

- `at` : horodatage ponctuel via `schedule.at` (ISO 8601).
- `every` : intervalle fixe (ms).
- `cron` : expression cron à 5 champs avec fuseau horaire IANA optionnel.

Les expressions cron utilisent `croner`. Si un fuseau horaire est omis, le fuseau horaire
local de l’hôte du Gateway est utilisé.

### Exécution principale vs isolée

#### Tâches de session principale (événements système)

Les tâches principales mettent en file d’attente un événement système et peuvent, en option, réveiller le runner de heartbeat.
Elles doivent utiliser `payload.kind = "systemEvent"`.

- `wakeMode: "now"` : l’événement déclenche un heartbeat immédiat.
- `wakeMode: "next-heartbeat"` (par défaut) : l’événement attend le prochain heartbeat planifié.

C’est le meilleur choix lorsque vous voulez le prompt de heartbeat normal + le contexte de session principale.
Voir [Heartbeat](/gateway/heartbeat).

#### Tâches isolées (sessions cron dédiées)

Les tâches isolées exécutent un tour d’agent dédié dans la session `cron:<jobId>`.

Comportements clés :

- Le prompt est préfixé par `[cron:<jobId> <job name>]` pour la traçabilité.
- Chaque exécution démarre un **id de session neuf** (pas de reprise de conversation précédente).
- Comportement par défaut : si `delivery` est omis, les tâches isolées annoncent un résumé (`delivery.mode = "announce"`).
- `delivery.mode` (isolé uniquement) choisit ce qui se passe :
  - `announce` : livrer un résumé au canal cible et publier un bref résumé dans la session principale.
  - `none` : interne uniquement (pas de livraison, pas de résumé de session principale).
- `wakeMode` contrôle quand le résumé de la session principale est publié :
  - `now` : heartbeat immédiat.
  - `next-heartbeat` : attend le prochain heartbeat planifié.

Utilisez les tâches isolées pour des tâches bruyantes, fréquentes ou des « corvées d’arrière-plan » qui ne doivent pas polluer
l’historique de votre chat principal.

### Formes de charge utile (ce qui s’exécute)

Deux types de charge utile sont pris en charge :

- `systemEvent` : session principale uniquement, routée via le prompt de heartbeat.
- `agentTurn` : session isolée uniquement, exécute un tour d’agent dédié.

Champs communs `agentTurn` :

- `message` : texte du prompt requis.
- `model` / `thinking` : remplacements optionnels (voir ci-dessous).
- `timeoutSeconds` : remplacement optionnel du délai d’expiration.

Configuration de livraison (tâches isolées uniquement) :

- `delivery.mode` : `none` | `announce`.
- `delivery.channel` : `last` ou un canal spécifique.
- `delivery.to` : cible spécifique au canal (téléphone/chat/id de canal).
- `delivery.bestEffort` : éviter l’échec de la tâche si la livraison de l’annonce échoue.

La livraison par annonce supprime les envois via l’outil de messagerie pour l’exécution ; utilisez `delivery.channel`/`delivery.to`
pour cibler le chat à la place. Lorsque `delivery.mode = "none"`, aucun résumé n’est publié dans la session principale.

Si `delivery` est omis pour les tâches isolées, OpenClaw utilise par défaut `announce`.

#### Flux de livraison par annonce

Lorsque `delivery.mode = "announce"`, cron livre directement via les adaptateurs de canaux sortants.
L’agent principal n’est pas lancé pour rédiger ou transférer le message.

Détails de comportement :

- Contenu : la livraison utilise les charges utiles sortantes de l’exécution isolée (texte/médias) avec le découpage
  et le formatage de canal habituels.
- Les réponses uniquement heartbeat (`HEARTBEAT_OK` sans contenu réel) ne sont pas livrées.
- Si l’exécution isolée a déjà envoyé un message vers la même cible via l’outil de messagerie, la livraison est
  ignorée pour éviter les doublons.
- Les cibles de livraison manquantes ou invalides font échouer la tâche sauf si `delivery.bestEffort = true`.
- Un court résumé est publié dans la session principale uniquement lorsque `delivery.mode = "announce"`.
- Le résumé de la session principale respecte `wakeMode` : `now` déclenche un heartbeat immédiat et
  `next-heartbeat` attend le prochain heartbeat planifié.

### Remplacements de modèle et de niveau de raisonnement

Les tâches isolées (`agentTurn`) peuvent remplacer le modèle et le niveau de raisonnement :

- `model` : chaîne fournisseur/modèle (par ex. `anthropic/claude-sonnet-4-20250514`) ou alias (par ex.
- `thinking` : niveau de raisonnement (`off`, `minimal`, `low`, `medium`, `high`, `xhigh` ; modèles GPT-5.2 + Codex uniquement)

Remarque : vous pouvez aussi définir `model` sur les tâches de session principale, mais cela modifie le modèle partagé de la
session principale. Nous recommandons les remplacements de modèle uniquement pour les tâches isolées afin d’éviter des
changements de contexte inattendus.

Priorité de résolution :

1. Remplacement de la charge utile de la tâche (le plus élevé)
2. Valeurs par défaut spécifiques aux hooks (par ex. `hooks.gmail.model`)
3. Valeur par défaut de la configuration de l’agent

### Livraison (canal + cible)

Les tâches isolées peuvent livrer la sortie vers un canal via la configuration de niveau supérieur `delivery` :

- `delivery.mode` : `announce` (livrer un résumé) ou `none`.
- `delivery.channel` : `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.
- `delivery.to` : cible destinataire spécifique au canal.

La configuration de livraison n’est valide que pour les tâches isolées (`sessionTarget: "isolated"`).

Si `delivery.channel` ou `delivery.to` est omis, cron peut se rabattre sur la « dernière route »
de la session principale (le dernier endroit où l’agent a répondu).

Rappels sur le format des cibles :

- Les cibles Slack/Discord/Mattermost (plugin) doivent utiliser des préfixes explicites (par ex. `channel:<id>`, `user:<id>`) pour éviter toute ambiguïté.
- Les sujets Telegram doivent utiliser la forme `:topic:` (voir ci-dessous).

#### Cibles de livraison Telegram (sujets / fils de forum)

Telegram prend en charge les sujets de forum via `message_thread_id`. Pour la livraison cron, vous pouvez encoder
le sujet/fil dans le champ `to` :

- `-1001234567890` (id de chat uniquement)
- `-1001234567890:topic:123` (préféré : marqueur de sujet explicite)
- `-1001234567890:123` (raccourci : suffixe numérique)

Les cibles préfixées comme `telegram:...` / `telegram:group:...` sont également acceptées :

- `telegram:group:-1001234567890:topic:123`

## Schéma JSON pour les appels d’outil

Utilisez ces formes lorsque vous appelez directement les outils `cron.*` du Gateway (appels d’outil de l’agent ou RPC).
Les indicateurs CLI acceptent des durées lisibles comme `20m`, mais les appels d’outil doivent utiliser une chaîne ISO 8601
pour `schedule.at` et des millisecondes pour `schedule.everyMs`.

### Paramètres cron.add

Tâche ponctuelle, session principale (événement système) :

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

Tâche isolée récurrente avec livraison :

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

Remarques :

- `schedule.kind` : `at` (`at`), `every` (`everyMs`), ou `cron` (`expr`, `tz` optionnel).
- `schedule.at` accepte l’ISO 8601 (fuseau horaire optionnel ; traité comme UTC s’il est omis).
- `everyMs` est en millisecondes.
- `sessionTarget` doit être `"main"` ou `"isolated"` et doit correspondre à `payload.kind`.
- Champs optionnels : `agentId`, `description`, `enabled`, `deleteAfterRun` (par défaut à true pour `at`),
  `delivery`.
- `wakeMode` vaut par défaut `"next-heartbeat"` lorsqu’il est omis.

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

Remarques :

- `jobId` est canonique ; `id` est accepté pour compatibilité.
- Utilisez `agentId: null` dans le patch pour effacer une liaison d’agent.

### Paramètres cron.run et cron.remove

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Stockage & historique

- Stockage des tâches : `~/.openclaw/cron/jobs.json` (JSON géré par le Gateway).
- Historique d’exécution : `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, élagué automatiquement).
- Remplacer le chemin de stockage : `cron.store` dans la configuration.

## Configuration

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Désactiver cron entièrement :

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## Demarrage rapide CLI

Rappel ponctuel (ISO UTC, suppression automatique après succès) :

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Rappel ponctuel (session principale, réveil immédiat) :

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

Tâche isolée récurrente (livraison vers un sujet Telegram) :

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

Tâche isolée avec remplacement de modèle et de raisonnement :

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

Sélection d’agent (configurations multi-agents) :

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Lancement manuel (force est la valeur par défaut, utilisez `--due` pour ne s'exécuter que lorsque due) :

```bash
openclaw cron run <jobId> --force
```

Modifier une tâche existante (patch des champs) :

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Historique d’exécution :

```bash
openclaw cron runs --id <jobId> --limit 50
```

Événement système immédiat sans créer de tâche :

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Surface de l’API Gateway

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (forcé ou dû), `cron.runs`
  Pour des événements système immédiats sans tâche, utilisez [`openclaw system event`](/cli/system).

## Problemes courants

### « Rien ne s’exécute »

- Vérifiez que cron est activé : `cron.enabled` et `OPENCLAW_SKIP_CRON`.
- Vérifiez que le Gateway fonctionne en continu (cron s’exécute dans le processus du Gateway).
- Pour les planifications `cron` : confirmez le fuseau horaire (`--tz`) par rapport au fuseau de l’hôte.

### Une tâche récurrente ne cesse de retarder après les échecs

- OpenClaw applique une nouvelle tentative exponentielle pour les tâches récurrentes après des erreurs consécutives :
  30s, 1m, 5m, 15m, puis 60m entre les tentatives.
- Le backoff se réinitialise automatiquement après la prochaine exécution réussie.
- Les jobs one-shot (`at`) sont désactivés après un lancement de terminal (`ok`, `error`, ou `skipped`) et ne recommencent pas.

### Telegram livre au mauvais endroit

- Pour les sujets de forum, utilisez `-100…:topic:<id>` afin que ce soit explicite et sans ambiguïté.
- Si vous voyez des préfixes `telegram:...` dans les journaux ou dans les cibles « dernière route » stockées, c’est normal ;
  la livraison cron les accepte et analyse toujours correctement les ID de sujet.
