---
summary: "Messages de polling heartbeat et règles de notification"
read_when:
  - Ajustement de la cadence ou de la messagerie heartbeat
  - Décision entre heartbeat et cron pour les tâches planifiées
title: "Heartbeat"
---

# Heartbeat (Passerelle)

> **Heartbeat ou Cron ?** Voir [Cron vs Heartbeat](/fr-FR/automation/cron-vs-heartbeat) pour des conseils sur quand utiliser chacun.

Heartbeat exécute des **tours d'agents périodiques** dans la session principale afin que le modèle puisse
signaler tout ce qui nécessite de l'attention sans vous spammer.

Dépannage : [/automation/troubleshooting](/fr-FR/automation/troubleshooting)

## Démarrage rapide (débutant)

1. Laissez les heartbeats activés (par défaut `30m`, ou `1h` pour Anthropic OAuth/setup-token) ou définissez votre propre cadence.
2. Créez une petite checklist `HEARTBEAT.md` dans l'espace de travail de l'agent (optionnel mais recommandé).
3. Décidez où les messages heartbeat doivent aller (`target: "last"` est la valeur par défaut).
4. Optionnel : activez la livraison du raisonnement heartbeat pour la transparence.
5. Optionnel : restreignez les heartbeats aux heures actives (heure locale).

Exemple de configuration :

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optionnel : envoyer aussi le message `Reasoning:` séparé
      },
    },
  },
}
```

## Valeurs par défaut

- Intervalle : `30m` (ou `1h` quand Anthropic OAuth/setup-token est le mode d'authentification détecté). Définissez `agents.defaults.heartbeat.every` ou par agent `agents.list[].heartbeat.every` ; utilisez `0m` pour désactiver.
- Corps du prompt (configurable via `agents.defaults.heartbeat.prompt`) :
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Le prompt heartbeat est envoyé **textuellement** comme message utilisateur. Le prompt
  système inclut une section "Heartbeat" et l'exécution est marquée en interne.
- Les heures actives (`heartbeat.activeHours`) sont vérifiées dans le fuseau horaire configuré.
  En dehors de la fenêtre, les heartbeats sont sautés jusqu'au prochain tick dans la fenêtre.

## À quoi sert le prompt heartbeat

Le prompt par défaut est intentionnellement large :

- **Tâches en arrière-plan** : "Consider outstanding tasks" incite l'agent à revoir
  les suivis (boîte de réception, calendrier, rappels, travail en file) et signaler tout ce qui est urgent.
- **Check-in humain** : "Checkup sometimes on your human during day time" incite à un
  message occasionnel léger "besoin de quelque chose ?", mais évite le spam nocturne
  en utilisant votre fuseau horaire local configuré (voir [/concepts/timezone](/fr-FR/concepts/timezone)).

Si vous voulez qu'un heartbeat fasse quelque chose de très spécifique (ex : "vérifier les
stats Gmail PubSub" ou "vérifier la santé de la passerelle"), définissez `agents.defaults.heartbeat.prompt` (ou
`agents.list[].heartbeat.prompt`) sur un corps personnalisé (envoyé textuellement).

## Contrat de réponse

- Si rien ne nécessite d'attention, répondez avec **`HEARTBEAT_OK`**.
- Pendant les exécutions heartbeat, OpenClaw traite `HEARTBEAT_OK` comme un acquittement quand il apparaît
  au **début ou à la fin** de la réponse. Le jeton est supprimé et la réponse est
  abandonnée si le contenu restant est **≤ `ackMaxChars`** (par défaut : 300).
- Si `HEARTBEAT_OK` apparaît au **milieu** d'une réponse, il n'est pas traité
  spécialement.
- Pour les alertes, **n'incluez pas** `HEARTBEAT_OK` ; retournez uniquement le texte d'alerte.

En dehors des heartbeats, un `HEARTBEAT_OK` égaré au début/fin d'un message est supprimé
et journalisé ; un message qui est seulement `HEARTBEAT_OK` est abandonné.

## Configuration

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // par défaut : 30m (0m désactive)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // par défaut : false (livrer un message Reasoning: séparé quand disponible)
        target: "last", // last | none | <id canal> (core ou plugin, ex : "bluebubbles")
        to: "+15551234567", // override optionnel spécifique au canal
        accountId: "ops-bot", // id de canal multi-compte optionnel
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max caractères autorisés après HEARTBEAT_OK
      },
    },
  },
}
```

### Portée et précédence

- `agents.defaults.heartbeat` définit le comportement heartbeat global.
- `agents.list[].heartbeat` fusionne par-dessus ; si un agent a un bloc `heartbeat`, **seuls ces agents** exécutent des heartbeats.
- `channels.defaults.heartbeat` définit les valeurs par défaut de visibilité pour tous les canaux.
- `channels.<canal>.heartbeat` écrase les valeurs par défaut des canaux.
- `channels.<canal>.accounts.<id>.heartbeat` (canaux multi-comptes) écrase les paramètres par canal.

### Heartbeats par agent

Si une entrée `agents.list[]` inclut un bloc `heartbeat`, **seuls ces agents**
exécutent des heartbeats. Le bloc par agent fusionne par-dessus `agents.defaults.heartbeat`
(donc vous pouvez définir des valeurs par défaut partagées une fois et écraser par agent).

Exemple : deux agents, seul le deuxième agent exécute des heartbeats.

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

### Exemple d'heures actives

Restreindre les heartbeats aux heures de bureau dans un fuseau horaire spécifique :

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
          timezone: "America/New_York", // optionnel ; utilise votre userTimezone si défini, sinon tz de l'hôte
        },
      },
    },
  },
}
```

En dehors de cette fenêtre (avant 9h ou après 22h heure de l'Est), les heartbeats sont sautés. Le prochain tick planifié dans la fenêtre s'exécutera normalement.

### Exemple multi-compte

Utilisez `accountId` pour cibler un compte spécifique sur les canaux multi-comptes comme Telegram :

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
        "ops-bot": { botToken: "VOTRE_TOKEN_BOT_TELEGRAM" },
      },
    },
  },
}
```

### Notes sur les champs

- `every` : intervalle heartbeat (chaîne de durée ; unité par défaut = minutes).
- `model` : override optionnel de modèle pour les exécutions heartbeat (`provider/model`).
- `includeReasoning` : quand activé, livre aussi le message `Reasoning:` séparé quand disponible (même forme que `/reasoning on`).
- `session` : clé de session optionnelle pour les exécutions heartbeat.
  - `main` (par défaut) : session principale de l'agent.
  - Clé de session explicite (copiez depuis `openclaw sessions --json` ou le [CLI sessions](/fr-FR/cli/sessions)).
  - Formats de clé de session : voir [Sessions](/fr-FR/concepts/session) et [Groupes](/fr-FR/channels/groups).
- `target` :
  - `last` (par défaut) : livrer au dernier canal externe utilisé.
  - canal explicite : `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none` : exécuter le heartbeat mais **ne pas livrer** en externe.
- `to` : override optionnel de destinataire (id spécifique au canal, ex : E.164 pour WhatsApp ou un id de chat Telegram).
- `accountId` : id de compte optionnel pour les canaux multi-comptes. Quand `target: "last"`, l'id de compte s'applique au dernier canal résolu s'il supporte les comptes ; sinon il est ignoré. Si l'id de compte ne correspond pas à un compte configuré pour le canal résolu, la livraison est sautée.
- `prompt` : écrase le corps du prompt par défaut (non fusionné).
- `ackMaxChars` : max caractères autorisés après `HEARTBEAT_OK` avant livraison.
- `activeHours` : restreint les exécutions heartbeat à une fenêtre de temps. Objet avec `start` (HH:MM, inclusif), `end` (HH:MM exclusif ; `24:00` autorisé pour fin de journée), et `timezone` optionnel.
  - Omis ou `"user"` : utilise votre `agents.defaults.userTimezone` si défini, sinon repli sur le fuseau horaire du système hôte.
  - `"local"` : utilise toujours le fuseau horaire du système hôte.
  - N'importe quel identifiant IANA (ex : `America/New_York`) : utilisé directement ; si invalide, repli sur le comportement `"user"` ci-dessus.
  - En dehors de la fenêtre active, les heartbeats sont sautés jusqu'au prochain tick dans la fenêtre.

## Comportement de livraison

- Les heartbeats s'exécutent dans la session principale de l'agent par défaut (`agent:<id>:<mainKey>`),
  ou `global` quand `session.scope = "global"`. Définissez `session` pour écraser vers une
  session de canal spécifique (Discord/WhatsApp/etc.).
- `session` n'affecte que le contexte d'exécution ; la livraison est contrôlée par `target` et `to`.
- Pour livrer à un canal/destinataire spécifique, définissez `target` + `to`. Avec
  `target: "last"`, la livraison utilise le dernier canal externe pour cette session.
- Si la file principale est occupée, le heartbeat est sauté et réessayé plus tard.
- Si `target` se résout en aucune destination externe, l'exécution a toujours lieu mais aucun
  message sortant n'est envoyé.
- Les réponses heartbeat uniquement ne **gardent pas** la session en vie ; le dernier `updatedAt`
  est restauré donc l'expiration d'inactivité se comporte normalement.

## Contrôles de visibilité

Par défaut, les acquittements `HEARTBEAT_OK` sont supprimés tandis que le contenu d'alerte est
livré. Vous pouvez ajuster cela par canal ou par compte :

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Cacher HEARTBEAT_OK (par défaut)
      showAlerts: true # Montrer les messages d'alerte (par défaut)
      useIndicator: true # Émettre des événements indicateurs (par défaut)
  telegram:
    heartbeat:
      showOk: true # Montrer les acquittements OK sur Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Supprimer la livraison d'alertes pour ce compte
```

Précédence : par compte → par canal → valeurs par défaut des canaux → valeurs par défaut intégrées.

### Ce que fait chaque flag

- `showOk` : envoie un acquittement `HEARTBEAT_OK` quand le modèle renvoie une réponse OK uniquement.
- `showAlerts` : envoie le contenu d'alerte quand le modèle renvoie une réponse non-OK.
- `useIndicator` : émet des événements indicateurs pour les surfaces de statut UI.

Si **tous les trois** sont false, OpenClaw saute complètement l'exécution heartbeat (pas d'appel de modèle).

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
      showOk: true # tous les comptes Slack
    accounts:
      ops:
        heartbeat:
          showAlerts: false # supprimer les alertes pour le compte ops uniquement
  telegram:
    heartbeat:
      showOk: true
```

### Modèles courants

| Objectif                                                   | Configuration                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Comportement par défaut (OK silencieux, alertes actives)   | _(pas de config nécessaire)_                                                             |
| Entièrement silencieux (pas de messages, pas d'indicateur) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Indicateur uniquement (pas de messages)                    | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OK dans un seul canal                                      | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (optionnel)

Si un fichier `HEARTBEAT.md` existe dans l'espace de travail, le prompt par défaut indique à
l'agent de le lire. Considérez-le comme votre "checklist heartbeat" : petite, stable, et
sûre à inclure toutes les 30 minutes.

Si `HEARTBEAT.md` existe mais est effectivement vide (seulement des lignes vides et des
en-têtes markdown comme `# Heading`), OpenClaw saute l'exécution heartbeat pour économiser des appels API.
Si le fichier est manquant, le heartbeat s'exécute quand même et le modèle décide quoi faire.

Gardez-le minuscule (checklist courte ou rappels) pour éviter le bloat de prompt.

Exemple `HEARTBEAT.md` :

```md
# Checklist heartbeat

- Scan rapide : quelque chose d'urgent dans les boîtes de réception ?
- Si c'est la journée, faire un check-in léger si rien d'autre n'est en attente.
- Si une tâche est bloquée, noter _ce qui manque_ et demander à Peter la prochaine fois.
```

### L'agent peut-il mettre à jour HEARTBEAT.md ?

Oui — si vous le lui demandez.

`HEARTBEAT.md` est juste un fichier normal dans l'espace de travail de l'agent, donc vous pouvez dire à
l'agent (dans un chat normal) quelque chose comme :

- "Mettre à jour `HEARTBEAT.md` pour ajouter une vérification quotidienne du calendrier."
- "Réécrire `HEARTBEAT.md` pour qu'il soit plus court et concentré sur les suivis de boîte de réception."

Si vous voulez que cela se produise de manière proactive, vous pouvez aussi inclure une ligne explicite dans
votre prompt heartbeat comme : "Si la checklist devient obsolète, mettre à jour HEARTBEAT.md
avec une meilleure."

Note de sécurité : ne mettez pas de secrets (clés API, numéros de téléphone, jetons privés) dans
`HEARTBEAT.md` — il devient partie du contexte de prompt.

## Réveil manuel (à la demande)

Vous pouvez mettre en file un événement système et déclencher un heartbeat immédiat avec :

```bash
openclaw system event --text "Vérifier les suivis urgents" --mode now
```

Si plusieurs agents ont `heartbeat` configuré, un réveil manuel exécute chacun de ces
heartbeats d'agents immédiatement.

Utilisez `--mode next-heartbeat` pour attendre le prochain tick planifié.

## Livraison du raisonnement (optionnel)

Par défaut, les heartbeats livrent seulement le payload "réponse" final.

Si vous voulez de la transparence, activez :

- `agents.defaults.heartbeat.includeReasoning: true`

Quand activé, les heartbeats livreront aussi un message séparé préfixé
`Reasoning:` (même forme que `/reasoning on`). Cela peut être utile quand l'agent
gère plusieurs sessions/codex et que vous voulez voir pourquoi il a décidé de vous pinguer
— mais cela peut aussi fuiter plus de détails internes que vous ne le souhaitez. Préférez le garder
désactivé dans les chats de groupe.

## Conscience du coût

Les heartbeats exécutent des tours d'agents complets. Des intervalles plus courts brûlent plus de jetons. Gardez
`HEARTBEAT.md` petit et considérez un `model` moins cher ou `target: "none"` si vous
voulez seulement des mises à jour d'état internes.
