---
summary: "Conseils pour choisir entre heartbeat et les tâches cron pour l’automatisation"
read_when:
  - Choisir comment planifier des tâches récurrentes
  - Mettre en place une surveillance ou des notifications en arrière-plan
  - Optimiser l’utilisation des tokens pour des vérifications périodiques
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat : quand utiliser chacun

Les heartbeats et les tâches cron vous permettent tous deux d’exécuter des tâches selon un planning. Ce guide vous aide à choisir le mécanisme adapté à votre cas d’usage.

## Guide de décision rapide

| Cas d’usage                                          | Recommandé                                  | Pourquoi                                                    |
| ---------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| Vérifier la boîte de réception toutes les 30 min     | Heartbeat                                   | Regroupé avec d’autres vérifications, conscient du contexte |
| Envoyer un rapport quotidien à 9h précises           | Cron (isolé)             | Timing exact requis                                         |
| Surveiller le calendrier pour les événements à venir | Heartbeat                                   | Adapté naturellement à une vigilance périodique             |
| Exécuter une analyse approfondie hebdomadaire        | Cron (isolé)             | Tâche autonome, peut utiliser un autre modèle               |
| Me rappeler dans 20 minutes                          | Cron (principal, `--at`) | Exécution unique avec timing précis                         |
| Vérification de l’état d’un projet en arrière-plan   | Heartbeat                                   | S’appuie sur un cycle existant                              |

## Heartbeat : vigilance périodique

Les heartbeats s’exécutent dans la **session principale** à intervalle régulier (par défaut : 30 min). Ils sont conçus pour permettre à l’agent de vérifier l’état des choses et de faire remonter ce qui est important.

### Quand utiliser heartbeat

- **Plusieurs vérifications périodiques** : au lieu de 5 tâches cron distinctes vérifiant la boîte de réception, le calendrier, la météo, les notifications et l’état des projets, un seul heartbeat peut tout regrouper.
- **Décisions conscientes du contexte** : l’agent dispose de tout le contexte de la session principale et peut décider intelligemment de ce qui est urgent ou non.
- **Continuité conversationnelle** : les exécutions heartbeat partagent la même session, l’agent se souvient donc des conversations récentes et peut faire un suivi naturel.
- **Surveillance à faible surcoût** : un heartbeat remplace de nombreuses petites tâches de polling.

### Avantages de heartbeat

- **Regroupe plusieurs vérifications** : un seul tour d’agent peut examiner la boîte de réception, le calendrier et les notifications ensemble.
- **Réduit les appels API** : un heartbeat unique coûte moins que 5 tâches cron isolées.
- **Conscient du contexte** : l’agent sait sur quoi vous avez travaillé et peut prioriser en conséquence.
- **Suppression intelligente** : si rien ne nécessite d’attention, l’agent répond `HEARTBEAT_OK` et aucun message n’est délivré.
- **Timing naturel** : dérive légèrement selon la charge de la file, ce qui convient à la plupart des surveillances.

### Exemple de heartbeat : checklist HEARTBEAT.md

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

L’agent lit ceci à chaque heartbeat et traite tous les éléments en un seul tour.

### Configuration de heartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

Voir [Heartbeat](/gateway/heartbeat) pour la configuration complète.

## Cron : planification précise

Les tâches cron s’exécutent à des **horaires exacts** et peuvent fonctionner dans des sessions isolées sans affecter le contexte principal.

### Quand utiliser cron

- **Timing exact requis** : « Envoyer ceci à 9h00 tous les lundis » (pas « vers 9h »).
- **Tâches autonomes** : tâches qui n’ont pas besoin de contexte conversationnel.
- **Modèle/réflexion différente** : analyses lourdes justifiant un modèle plus puissant.
- **Rappels uniques** : « Rappelle‑moi dans 20 minutes » avec `--at`.
- **Tâches bruyantes/fréquentes** : tâches qui encombreraient l’historique de la session principale.
- **Déclencheurs externes** : tâches devant s’exécuter indépendamment de l’activité de l’agent.

### Avantages de cron

- **Timing exact** : expressions cron à 5 champs avec prise en charge des fuseaux horaires.
- **Isolation de session** : s’exécute dans `cron:<jobId>` sans polluer l’historique principal.
- **Override de modèle** : utiliser un modèle moins cher ou plus puissant par tâche.
- **Contrôle de livraison** : les tâches isolées utilisent par défaut `announce` (résumé) ; choisissez `none` si nécessaire.
- **Livraison immédiate** : le mode annonce publie directement sans attendre le heartbeat.
- **Aucun contexte d’agent requis** : s’exécute même si la session principale est inactive ou compactée.
- **Support des tâches uniques** : `--at` pour des horodatages futurs précis.

### Exemple de cron : briefing matinal quotidien

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Cela s’exécute exactement à 7h00 heure de New York, utilise Opus pour la qualité et annonce directement un résumé sur WhatsApp.

### Exemple de cron : rappel unique

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Voir [Cron jobs](/automation/cron-jobs) pour la référence CLI complète.

## Diagramme de décision

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## Combiner les deux

La configuration la plus efficace utilise **les deux** :

1. **Heartbeat** gère la surveillance de routine (boîte de réception, calendrier, notifications) en un seul tour groupé toutes les 30 minutes.
2. **Cron** gère les plannings précis (rapports quotidiens, revues hebdomadaires) et les rappels uniques.

### Exemple : configuration d’automatisation efficace

**HEARTBEAT.md** (vérifié toutes les 30 min) :

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Tâches cron** (timing précis) :

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster : workflows déterministes avec validations

Lobster est le moteur de workflow pour des **pipelines d’outils multi‑étapes** nécessitant une exécution déterministe et des validations explicites.
Utilisez‑le lorsque la tâche dépasse un seul tour d’agent et que vous souhaitez un workflow reprenable avec des points de contrôle humains.

### Quand Lobster est adapté

- **Automatisation multi‑étapes** : vous avez besoin d’un pipeline fixe d’appels d’outils, pas d’un prompt ponctuel.
- **Portes de validation** : les effets de bord doivent s’interrompre jusqu’à votre approbation, puis reprendre.
- **Exécutions reprenables** : continuer un workflow en pause sans réexécuter les étapes précédentes.

### Comment il se combine avec heartbeat et cron

- **Heartbeat/cron** décident _quand_ une exécution a lieu.
- **Lobster** définit _quelles étapes_ se produisent une fois l’exécution lancée.

Pour les workflows planifiés, utilisez cron ou heartbeat pour déclencher un tour d’agent qui appelle Lobster.
Pour les workflows ad hoc, appelez Lobster directement.

### Notes opérationnelles (issues du code)

- Lobster s’exécute comme un **sous‑processus local** (`lobster` CLI) en mode outil et renvoie une **enveloppe JSON**.
- Si l’outil renvoie `needs_approval`, vous reprenez avec `resumeToken` et l’option `approve`.
- L’outil est un **plugin optionnel** ; activez‑le de manière additive via `tools.alsoAllow: ["lobster"]` (recommandé).
- Si vous passez `lobsterPath`, il doit s’agir d’un **chemin absolu**.

Voir [Lobster](/tools/lobster) pour l’utilisation complète et des exemples.

## Session principale vs session isolée

Heartbeat et cron peuvent tous deux interagir avec la session principale, mais de manière différente :

|            | Heartbeat                       | Cron (principal)                   | Cron (isolé)                   |
| ---------- | ------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| Session    | Principale                      | Principale (via événement système) | `cron:<jobId>`                                    |
| Historique | Partagé                         | Partagé                                               | Nouveau à chaque exécution                        |
| Contexte   | Complet                         | Complet                                               | Aucun (démarre à zéro)         |
| Modèle     | Modèle de la session principale | Modèle de la session principale                       | Peut être remplacé                                |
| Sortie     | Livrée si non `HEARTBEAT_OK`    | Prompt heartbeat + événement                          | Annonce du résumé (par défaut) |

### Quand utiliser un cron en session principale

Utilisez `--session main` avec `--system-event` lorsque vous souhaitez :

- Que le rappel/l’événement apparaisse dans le contexte de la session principale
- Que l’agent le traite lors du prochain heartbeat avec tout le contexte
- Aucune exécution isolée séparée

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Quand utiliser un cron isolé

Utilisez `--session isolated` lorsque vous souhaitez :

- Une ardoise propre sans contexte préalable
- Des paramètres de modèle ou de réflexion différents
- Annoncer directement des résumés dans un canal
- Un historique qui n’encombre pas la session principale

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## Considérations de coût

| Mécanisme                           | Profil de coût                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| Heartbeat                           | Un tour toutes les N minutes ; évolue avec la taille de HEARTBEAT.md |
| Cron (principal) | Ajoute un événement au prochain heartbeat (pas de tour isolé)     |
| Cron (isolé)     | Tour d’agent complet par tâche ; peut utiliser un modèle moins cher                  |

**Conseils** :

- Gardez `HEARTBEAT.md` petit pour minimiser la surcharge de tokens.
- Regroupez des vérifications similaires dans heartbeat plutôt que plusieurs tâches cron.
- Utilisez `target: "none"` sur heartbeat si vous voulez uniquement un traitement interne.
- Utilisez un cron isolé avec un modèle moins cher pour les tâches de routine.

## Liens connexes

- [Heartbeat](/gateway/heartbeat) - configuration complète de heartbeat
- [Cron jobs](/automation/cron-jobs) - référence complète CLI et API des tâches cron
- [System](/cli/system) - événements système + contrôles de heartbeat
