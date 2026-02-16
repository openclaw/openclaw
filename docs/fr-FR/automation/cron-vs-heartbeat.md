---
summary: "Conseils pour choisir entre heartbeat, cron ou webhook"
read_when:
  - Décider comment déclencher le travail de fond
  - Comparer les options d'automatisation
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat

OpenClaw propose deux mécanismes principaux d'automatisation : **heartbeat** (vérifie périodiquement)
et **cron** (planificateur de tâches). Choisissez en fonction de vos besoins :

## Aperçu rapide

| Fonctionnalité     | Heartbeat                                         | Cron                                                             |
| ------------------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| **Quand utiliser** | Vérifications régulières de la session principale | Tâches ponctuelles ou isolées récurrentes                        |
| **Context**        | Session principale partagée                       | Principal (événements système) ou isolé (dédié)                  |
| **Planification**  | Intervalle fixe                                   | Unique, intervalle, ou expression cron                           |
| **Charge utile**   | Invite système                                    | Événement système ou tour d'agent dédié                          |
| **Persistance**    | Non (re-planifie après chaque exécution)          | Oui (tâches stockées dans `~/.openclaw/cron/`)                   |
| **Multi-agent**    | Session principale uniquement                     | Peut épingler à un agent spécifique via `agentId`                |
| **Livraison**      | Session principale uniquement                     | Aucune, annonce vers n'importe quel canal, ou session principale |

## Heartbeat : vérifications de routine continues

**Utilisez heartbeat quand** vous voulez que l'agent vérifie régulièrement des messages, des calendriers,
des boîtes de réception, etc. pendant une session de chat en cours.

Avantages :

- Context de conversation normal (pas de session séparée).
- Simple : définissez un intervalle et une invite.
- Suspend automatiquement pendant l'activité active (ne perturbe pas le chat en cours).

Inconvénients :

- Pas de persistance : heartbeat re-planifie après chaque exécution.
- Pas de tâches isolées : toutes les vérifications impactent la session principale.
- Pas de livraison flexible : les heartbeats répondent toujours sur la session principale.

**Config** : [`heartbeat`](/fr-FR/gateway/heartbeat) (`intervalMs`, `prompt`).

Exemple :

```json
{
  "heartbeat": {
    "enabled": true,
    "intervalMs": 1200000,
    "prompt": "Vérifier les nouveaux messages, calendrier, e-mails. Si rien de nouveau, répondre HEARTBEAT_OK sans explication."
  }
}
```

## Cron : tâches programmées et déclencheurs dédiés

**Utilisez cron quand** vous devez :

- Exécuter des tâches ponctuelles ou à des heures spécifiques (ex., "07:00 chaque lundi").
- Isoler le travail de fond (les "corvées" ne doivent pas encombrer le chat principal).
- Livrer à un autre canal (ex., résumé vers WhatsApp le matin, notes de réunion vers Slack).
- Persister les tâches à travers les redémarrages de passerelle.

Avantages :

- Planification persistante : les redémarrages de passerelle ne perdent pas les tâches.
- Cibles d'exécution principales ou isolées : les tâches isolées maintiennent les corvées silencieuses.
- Livraison flexible : annonce vers n'importe quel canal (WhatsApp, Telegram, Slack, etc.) ou aucune.
- Fuseau horaire + expressions cron complètes avec `croner`.

Inconvénients :

- Plus complexe qu'un intervalle heartbeat simple.
- Démarrage à froid initial pour les tâches isolées (pas d'historique de conversation dans `cron:<jobId>`).

**CLI + APIs** : [`openclaw cron add`](/fr-FR/automation/cron-jobs), outil de passerelle `cron.add`, etc.

Exemples :

Récurrence isolée avec livraison d'annonce :

```bash
openclaw cron add \
  --name "Morning summary" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Résumer les mises à jour de la nuit." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Événement système principal unique (attend le prochain heartbeat) :

```bash
openclaw cron add \
  --name "Prep reminder" \
  --at "2026-02-15T10:00:00Z" \
  --session main \
  --system-event "Préparer les notes pour la réunion de 14h." \
  --wake next-heartbeat
```

## Résumé du compromis

- **Heartbeat** pour : vérifier la nouvelle activité, surveiller la boîte de réception/calendrier,
  vérifications périodiques de routine.
- **Cron** pour : tâches ponctuelles ou à heure fixe, tâches de fond isolées, livraison flexible.
- **Webhooks** pour : Pub/Sub en temps réel entrant (Gmail, Slack, etc.) ; utilisez cron pour
  vérification de secours (voir [`/automation/webhook`](/fr-FR/automation/webhook) et
  [`/automation/gmail-pubsub`](/fr-FR/automation/gmail-pubsub)).

Voir aussi : [Heartbeat](/fr-FR/gateway/heartbeat), [Cron](/fr-FR/automation/cron-jobs), [Dépannage](/fr-FR/automation/troubleshooting).
