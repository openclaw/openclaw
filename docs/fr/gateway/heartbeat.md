---
summary: "Messages de sondage Heartbeat et règles de notification"
read_when:
  - Ajuster la cadence ou la messagerie du heartbeat
  - Choisir entre heartbeat et cron pour les tâches planifiées
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat ou Cron ?** Voir [Cron vs Heartbeat](/automation/cron-vs-heartbeat) pour savoir quand utiliser chacun.

Heartbeat exécute des **tours d’agent périodiques** dans la session principale afin que le modèle
puisse faire remonter ce qui nécessite une attention sans vous spammer.

Dépannage : [/automation/troubleshooting](/automation/troubleshooting)

## Démarrage rapide (débutant)

1. Laissez les heartbeats activés (la valeur par défaut est `30m`, ou `1h` pour Anthropic OAuth/setup-token) ou définissez votre propre cadence.
2. Créez une petite checklist `HEARTBEAT.md` dans l’espace de travail de l’agent (facultatif mais recommandé).
3. Décidez où doivent aller les messages de heartbeat (`target: "last"` est la valeur par défaut).
4. Facultatif : activez la livraison du raisonnement du heartbeat pour plus de transparence.
5. Facultatif : limitez les heartbeats aux heures actives (heure locale).

Exemple de configuration :

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Valeurs par défaut

- Intervalle : `30m` (ou `1h` lorsque le mode d’authentification détecté est Anthropic OAuth/setup-token). Définissez `agents.defaults.heartbeat.every` ou par agent `agents.list[].heartbeat.every` ; utilisez `0m` pour désactiver.
- Corps du prompt (configurable via `agents.defaults.heartbeat.prompt`) :
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Le prompt de heartbeat est envoyé **verbatim** en tant que message utilisateur. Le prompt système
  inclut une section « Heartbeat » et l’exécution est marquée en interne.
- Les heures actives (`heartbeat.activeHours`) sont vérifiées dans le fuseau horaire configuré.
  En dehors de la plage, les heartbeats sont ignorés jusqu’au prochain tick dans la fenêtre.

## À quoi sert le prompt de heartbeat

Le prompt par défaut est volontairement large :

- **Tâches en arrière-plan** : « Consider outstanding tasks » incite l’agent à revoir
  les suivis (boîte de réception, calendrier, rappels, travail en file d’attente) et à faire remonter l’urgent.
- **Prise de contact humaine** : « Checkup sometimes on your human during day time » incite à
  un message léger occasionnel du type « avez-vous besoin de quelque chose ? », tout en évitant le spam nocturne
  grâce au fuseau horaire local configuré (voir [/concepts/timezone](/concepts/timezone)).

Si vous voulez qu’un heartbeat fasse quelque chose de très spécifique (par ex. « vérifier les stats Gmail PubSub »
ou « vérifier l’état de la passerelle »), définissez `agents.defaults.heartbeat.prompt` (ou
`agents.list[].heartbeat.prompt`) avec un corps personnalisé (envoyé verbatim).

## Contrat de réponse

- Si rien ne nécessite d’attention, répondez avec **`HEARTBEAT_OK`**.
- Pendant les exécutions de heartbeat, OpenClaw traite `HEARTBEAT_OK` comme un accusé de réception lorsqu’il apparaît
  au **début ou à la fin** de la réponse. Le jeton est supprimé et la réponse est
  ignorée si le contenu restant est **≤ `ackMaxChars`** (par défaut : 300).
- Si `HEARTBEAT_OK` apparaît au **milieu** d’une réponse, il n’est pas traité
  de manière spéciale.
- Pour les alertes, **n’incluez pas** `HEARTBEAT_OK` ; renvoyez uniquement le texte d’alerte.

En dehors des heartbeats, les `HEARTBEAT_OK` isolés en début/fin de message sont supprimés
et journalisés ; un message qui est uniquement `HEARTBEAT_OK` est ignoré.

## Configuration

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Portée et priorité

- `agents.defaults.heartbeat` définit le comportement global des heartbeats.
- `agents.list[].heartbeat` fusionne par-dessus ; si un agent possède un bloc `heartbeat`, **seuls ces agents** exécutent des heartbeats.
- `channels.defaults.heartbeat` définit les valeurs de visibilité par défaut pour tous les canaux.
- `channels.<channel>.heartbeat` remplace les valeurs par défaut des canaux.
- `channels.<channel>.accounts.<id>.heartbeat` (canaux multi-comptes) remplace les paramètres par canal.

### Heartbeats par agent

Si une entrée `agents.list[]` inclut un bloc `heartbeat`, **seuls ces agents**
exécutent des heartbeats. Le bloc par agent fusionne par-dessus `agents.defaults.heartbeat`
(vous pouvez donc définir des valeurs partagées une fois et les surcharger par agent).

Exemple : deux agents, seul le deuxième exécute des heartbeats.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Exemple d’heures actives

Limiter les heartbeats aux heures de bureau dans un fuseau horaire spécifique :

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

En dehors de cette plage (avant 9 h ou après 22 h heure de l’Est), les heartbeats sont ignorés. Le prochain tick planifié dans la fenêtre s’exécutera normalement.

### Exemple multi-compte

Utilisez `accountId` pour cibler un compte spécifique sur des canaux multi-comptes comme Telegram :

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Notes de champ

- `every` : intervalle de heartbeat (chaîne de durée ; unité par défaut = minutes).
- `model` : remplacement optionnel du modèle pour les exécutions de heartbeat (`provider/model`).
- `includeReasoning` : lorsqu’activé, livre aussi le message séparé `Reasoning:` lorsqu’il est disponible (même structure que `/reasoning on`).
- `session` : clé de session optionnelle pour les exécutions de heartbeat.
  - `main` (par défaut) : session principale de l’agent.
  - Clé de session explicite (copiez depuis `openclaw sessions --json` ou le [CLI des sessions](/cli/sessions)).
  - Formats de clé de session : voir [Sessions](/concepts/session) et [Groups](/concepts/groups).
- `target` :
  - `last` (par défaut) : livrer vers le dernier canal externe utilisé.
  - canal explicite : `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none` : exécuter le heartbeat mais **ne pas livrer** en externe.
- `to` : remplacement optionnel du destinataire (id spécifique au canal, p. ex. E.164 pour WhatsApp ou un id de chat Telegram).
- `accountId` : id de compte optionnel pour les canaux multi-comptes. Lorsque `target: "last"`, l’id de compte s’applique au dernier canal résolu s’il prend en charge les comptes ; sinon il est ignoré. Si l’id de compte ne correspond pas à un compte configuré pour le canal résolu, la livraison est ignorée.
- `prompt` : remplace le corps du prompt par défaut (non fusionné).
- `ackMaxChars` : nombre maximal de caractères autorisés après `HEARTBEAT_OK` avant livraison.
- `activeHours` : limite les exécutions de heartbeat à une plage horaire. Objet avec `start` (HH:MM, inclusif), `end` (HH:MM exclusif ; `24:00` autorisé pour fin de journée), et `timezone` optionnel.
  - Omission ou `"user"` : utilise votre `agents.defaults.userTimezone` s’il est défini, sinon revient au fuseau horaire du système hôte.
  - `"local"` : utilise toujours le fuseau horaire du système hôte.
  - Tout identifiant IANA (p. ex. `America/New_York`) : utilisé directement ; s’il est invalide, revient au comportement `"user"` ci-dessus.
  - En dehors de la fenêtre active, les heartbeats sont ignorés jusqu’au prochain tick dans la fenêtre.

## Comportement de livraison

- Les heartbeats s’exécutent par défaut dans la session principale de l’agent (`agent:<id>:<mainKey>`),
  ou `global` lorsque `session.scope = "global"`. Définissez `session` pour remplacer par une
  session de canal spécifique (Discord/WhatsApp/etc.).
- `session` n’affecte que le contexte d’exécution ; la livraison est contrôlée par `target` et `to`.
- Pour livrer vers un canal/destinataire spécifique, définissez `target` + `to`. Avec
  `target: "last"`, la livraison utilise le dernier canal externe pour cette session.
- Si la file principale est occupée, le heartbeat est ignoré et réessayé plus tard.
- Si `target` ne se résout vers aucune destination externe, l’exécution a quand même lieu mais aucun
  message sortant n’est envoyé.
- Les réponses uniquement heartbeat **ne** maintiennent **pas** la session active ; le dernier `updatedAt`
  est restauré afin que l’expiration d’inactivité se comporte normalement.

## Contrôles de visibilité

Par défaut, les accusés de réception `HEARTBEAT_OK` sont supprimés tandis que le contenu d’alerte est
livré. Vous pouvez ajuster cela par canal ou par compte :

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Priorité : par compte → par canal → valeurs par défaut du canal → valeurs par défaut intégrées.

### Que fait chaque drapeau

- `showOk` : envoie un accusé de réception `HEARTBEAT_OK` lorsque le modèle renvoie une réponse OK uniquement.
- `showAlerts` : envoie le contenu d’alerte lorsque le modèle renvoie une réponse non-OK.
- `useIndicator` : émet des événements indicateurs pour les surfaces d’état de l’UI.

Si **les trois** sont à false, OpenClaw ignore entièrement l’exécution de heartbeat (aucun appel au modèle).

### Exemples par canal vs par compte

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Modèles communs

| Objectif                                                                    | Configuration                                                                            |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Comportement par défaut (OK silencieux, alertes actives) | _(aucune configuration nécessaire)_                                   |
| Totalement silencieux (aucun message, aucun indicateur)  | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Indicateur uniquement (aucun message)                    | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OK dans un seul canal                                                       | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (facultatif)

Si un fichier `HEARTBEAT.md` existe dans l’espace de travail, le prompt par défaut indique à l’agent
de le lire. Considérez-le comme votre « checklist de heartbeat » : petite, stable et
sans risque à inclure toutes les 30 minutes.

Si `HEARTBEAT.md` existe mais est effectivement vide (uniquement des lignes vides et des en-têtes markdown
comme `# Heading`), OpenClaw ignore l’exécution du heartbeat pour économiser des appels API.
Si le fichier est absent, le heartbeat s’exécute quand même et le modèle décide quoi faire.

Gardez-le minuscule (courte checklist ou rappels) pour éviter le gonflement du prompt.

Exemple de `HEARTBEAT.md` :

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### L’agent peut-il mettre à jour HEARTBEAT.md ?

Oui — si vous le lui demandez.

`HEARTBEAT.md` est simplement un fichier normal dans l’espace de travail de l’agent ; vous pouvez donc dire à
l’agent (dans une discussion normale) quelque chose comme :

- « Met à jour `HEARTBEAT.md` pour ajouter une vérification quotidienne du calendrier.
- « Réécris `HEARTBEAT.md` pour qu’il soit plus court et axé sur les suivis de la boîte de réception. »

Si vous voulez que cela se fasse de manière proactive, vous pouvez aussi inclure une ligne explicite dans
votre prompt de heartbeat comme : « Si la checklist devient obsolète, mets à jour HEARTBEAT.md avec une meilleure version. »

Note de sécurité : ne mettez pas de secrets (clés API, numéros de téléphone, jetons privés) dans
`HEARTBEAT.md` — il fait partie du contexte du prompt.

## Réveil manuel (à la demande)

Vous pouvez mettre en file un événement système et déclencher un heartbeat immédiat avec :

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Si plusieurs agents ont `heartbeat` configuré, un réveil manuel exécute immédiatement chacun de ces
heartbeats d’agent.

Utilisez `--mode next-heartbeat` pour attendre le prochain tick planifié.

## Livraison du raisonnement (facultatif)

Par défaut, les heartbeats ne livrent que la charge utile « réponse » finale.

Si vous souhaitez de la transparence, activez :

- `agents.defaults.heartbeat.includeReasoning: true`

Lorsqu’activé, les heartbeats livreront aussi un message séparé préfixé
`Reasoning:` (même structure que `/reasoning on`). Cela peut être utile lorsque l’agent
gère plusieurs sessions/codex et que vous voulez voir pourquoi il a décidé de vous
contacter — mais cela peut aussi divulguer plus de détails internes que souhaité. Préférez
le laisser désactivé dans les discussions de groupe.

## Sensibilisation aux coûts

Les heartbeats exécutent des tours d’agent complets. Des intervalles plus courts consomment plus de tokens. Gardez `HEARTBEAT.md` modéré et envisagez un `model` ou `target: "none"` moins coûteux si vous
ne souhaitez que des mises à jour d’état internes.
