---
summary: "Flux de messages, sessions, mise en file d'attente et visibilité du raisonnement"
read_when:
  - Expliquer comment les messages entrants deviennent des réponses
  - Clarifier les sessions, modes de file d'attente ou comportement de streaming
  - Documenter la visibilité du raisonnement et les implications d'utilisation
title: "Messages"
---

# Messages

Cette page relie comment OpenClaw gère les messages entrants, les sessions, la mise en file d'attente,
le streaming et la visibilité du raisonnement.

## Flux de messages (haut niveau)

```
Message entrant
  -> routage/liaisons -> clé de session
  -> file d'attente (si une exécution est active)
  -> exécution d'agent (streaming + outils)
  -> réponses sortantes (limites de canal + découpage)
```

Les boutons clés vivent dans la configuration :

- `messages.*` pour les préfixes, mise en file d'attente et comportement de groupe.
- `agents.defaults.*` pour les valeurs par défaut de streaming par blocs et découpage.
- Remplacements de canal (`channels.whatsapp.*`, `channels.telegram.*`, etc.) pour les plafonds et bascules de streaming.

Voir [Configuration](/fr-FR/gateway/configuration) pour le schéma complet.

## Dédupe entrant

Les canaux peuvent relivrer le même message après des reconnexions. OpenClaw garde un
cache de courte durée indexé par canal/compte/pair/session/id de message donc les livraisons
en double ne déclenchent pas une autre exécution d'agent.

## Débouncing entrant

Les messages consécutifs rapides du **même expéditeur** peuvent être regroupés en un seul
tour d'agent via `messages.inbound`. Le débouncing est délimité par canal + conversation
et utilise le message le plus récent pour le fil de réponse/IDs.

Config (par défaut global + remplacements par canal) :

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Notes :

- Le débounce s'applique aux messages **texte uniquement** ; les médias/pièces jointes vident immédiatement.
- Les commandes de contrôle contournent le débouncing donc elles restent autonomes.

## Sessions et appareils

Les sessions sont possédées par la passerelle, pas par les clients.

- Les chats directs se replient dans la clé de session principale de l'agent.
- Les groupes/canaux obtiennent leurs propres clés de session.
- Le magasin de session et les transcriptions vivent sur l'hôte de passerelle.

Plusieurs appareils/canaux peuvent mapper vers la même session, mais l'historique n'est pas entièrement
synchronisé vers chaque client. Recommandation : utilisez un appareil principal pour les longues
conversations pour éviter un contexte divergent. L'interface de contrôle et la TUI montrent toujours la
transcription de session soutenue par la passerelle, donc elles sont la source de vérité.

Détails : [Gestion de session](/fr-FR/concepts/session).

## Corps entrants et contexte d'historique

OpenClaw sépare le **corps d'invite** du **corps de commande** :

- `Body` : texte d'invite envoyé à l'agent. Cela peut inclure des enveloppes de canal et
  des enveloppes d'historique optionnelles.
- `CommandBody` : texte utilisateur brut pour l'analyse de directive/commande.
- `RawBody` : alias hérité pour `CommandBody` (gardé pour compatibilité).

Quand un canal fournit l'historique, il utilise une enveloppe partagée :

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

Pour les **chats non-directs** (groupes/canaux/salles), le **corps de message actuel** est préfixé avec l'étiquette
d'expéditeur (même style utilisé pour les entrées d'historique). Cela garde les messages en temps réel et en file d'attente/historique
cohérents dans l'invite d'agent.

Les tampons d'historique sont **en attente uniquement** : ils incluent les messages de groupe qui n'ont _pas_
déclenché une exécution (par exemple, messages contrôlés par mention) et **excluent** les messages
déjà dans la transcription de session.

Le retrait de directive s'applique uniquement à la section **message actuel** donc l'historique
reste intact. Les canaux qui enveloppent l'historique devraient définir `CommandBody` (ou
`RawBody`) au texte de message original et garder `Body` comme l'invite combinée.
Les tampons d'historique sont configurables via `messages.groupChat.historyLimit` (par défaut
global) et les remplacements par canal comme `channels.slack.historyLimit` ou
`channels.telegram.accounts.<id>.historyLimit` (définissez `0` pour désactiver).

## Mise en file d'attente et suivis

Si une exécution est déjà active, les messages entrants peuvent être mis en file d'attente, dirigés dans
l'exécution actuelle ou collectés pour un tour de suivi.

- Configurez via `messages.queue` (et `messages.queue.byChannel`).
- Modes : `interrupt`, `steer`, `followup`, `collect`, plus des variantes de backlog.

Détails : [Mise en file d'attente](/fr-FR/concepts/queue).

## Streaming, découpage et regroupement

Le streaming par blocs envoie des réponses partielles pendant que le modèle produit des blocs de texte.
Le découpage respecte les limites de texte de canal et évite de diviser le code clôturé.

Paramètres clés :

- `agents.defaults.blockStreamingDefault` (`on|off`, par défaut off)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (regroupement basé sur inactivité)
- `agents.defaults.humanDelay` (pause semblable à humain entre réponses par blocs)
- Remplacements de canal : `*.blockStreaming` et `*.blockStreamingCoalesce` (les canaux non-Telegram nécessitent explicitement `*.blockStreaming: true`)

Détails : [Streaming + découpage](/fr-FR/concepts/streaming).

## Visibilité du raisonnement et jetons

OpenClaw peut exposer ou cacher le raisonnement du modèle :

- `/reasoning on|off|stream` contrôle la visibilité.
- Le contenu de raisonnement compte toujours vers l'utilisation de jetons quand produit par le modèle.
- Telegram supporte le flux de raisonnement dans la bulle de brouillon.

Détails : [Directives de réflexion + raisonnement](/fr-FR/tools/thinking) et [Utilisation de jetons](/fr-FR/reference/token-use).

## Préfixes, fil et réponses

Le formatage de message sortant est centralisé dans `messages` :

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` et `channels.<channel>.accounts.<id>.responsePrefix` (cascade de préfixe sortant), plus `channels.whatsapp.messagePrefix` (préfixe entrant WhatsApp)
- Fil de réponse via `replyToMode` et valeurs par défaut par canal

Détails : [Configuration](/fr-FR/gateway/configuration#messages) et docs de canal.
