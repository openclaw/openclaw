---
summary: "Flux des messages, sessions, mise en file d’attente et visibilite du raisonnement"
read_when:
  - Expliquer comment les messages entrants deviennent des reponses
  - Clarifier les sessions, les modes de mise en file d’attente ou le comportement de streaming
  - Documenter la visibilite du raisonnement et ses implications d’utilisation
title: "Messages"
---

# Messages

Cette page relie la maniere dont OpenClaw gere les messages entrants, les sessions, la mise en file d’attente,
le streaming et la visibilite du raisonnement.

## Flux des messages (vue d’ensemble)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Les principaux reglages se trouvent dans la configuration :

- `messages.*` pour les prefixes, la mise en file d’attente et le comportement des groupes.
- `agents.defaults.*` pour le streaming par blocs et les valeurs par defaut de decoupage.
- Surcharges par canal (`channels.whatsapp.*`, `channels.telegram.*`, etc.) pour les limites et les bascules de streaming.

Voir [Configuration](/gateway/configuration) pour le schema complet.

## Deduplication entrante

Les canaux peuvent redistribuer le meme message apres des reconnexions. OpenClaw conserve un cache de courte duree
indexe par canal/compte/peer/session/id de message afin que les livraisons en double ne declenchent pas une nouvelle execution de l’agent.

## Délivrance entrante

Des messages consecutifs rapides provenant du **meme expediteur** peuvent etre regroupes en un seul tour
d’agent via `messages.inbound`. Le debouncing est delimite par canal + conversation
et utilise le message le plus recent pour le fil de reponse et les IDs.

Configuration (defaut global + surcharges par canal) :

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

- Le debouncing s’applique aux messages **texte uniquement** ; les medias/pieces jointes sont envoyes immediatement.
- Les commandes de controle contournent le debouncing afin de rester autonomes.

## Sessions et appareils

Les sessions appartiennent a la Gateway (passerelle), pas aux clients.

- Les discussions directes sont regroupees dans la cle de session principale de l’agent.
- Les groupes/canaux obtiennent leurs propres cles de session.
- Le stockage des sessions et les transcriptions resident sur l’hote de la passerelle.

Plusieurs appareils/canaux peuvent correspondre a la meme session, mais l’historique n’est pas completement
resynchronise vers chaque client. Recommandation : utiliser un appareil principal pour les conversations longues
afin d’eviter un contexte divergent. L’UI de controle et la TUI affichent toujours la transcription de session
adossee a la passerelle ; elles constituent donc la source de verite.

Details : [Gestion des sessions](/concepts/session).

## Corps entrants et contexte d’historique

OpenClaw separe le **corps du prompt** du **corps de commande** :

- `Body` : texte du prompt envoye a l’agent. Cela peut inclure des enveloppes de canal et
  des wrappers d’historique optionnels.
- `CommandBody` : texte utilisateur brut pour l’analyse des directives/commandes.
- `RawBody` : alias historique de `CommandBody` (conserve pour compatibilite).

Lorsqu’un canal fournit un historique, il utilise un wrapper partage :

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

Pour les **discussions non directes** (groupes/canaux/salles), le **corps du message courant** est prefixe par
l’etiquette de l’expediteur (meme style que celui utilise pour les entrees d’historique). Cela garantit la coherence
entre les messages en temps reel et ceux en file d’attente/historique dans le prompt de l’agent.

Les tampons d’historique sont **en attente uniquement** : ils incluent les messages de groupe qui n’ont _pas_
declenche d’execution (par exemple, des messages soumis a des mentions) et **excluent** les messages
deja presents dans la transcription de session.

La suppression des directives ne s’applique qu’a la section du **message courant** afin que l’historique
reste intact. Les canaux qui enveloppent l’historique doivent definir `CommandBody` (ou
`RawBody`) avec le texte du message original et conserver `Body` comme prompt combine.
Les tampons d’historique sont configurables via `messages.groupChat.historyLimit` (defaut
global) et des surcharges par canal comme `channels.slack.historyLimit` ou
`channels.telegram.accounts.<id>.historyLimit` (definir `0` pour desactiver).

## Mise en file d’attente et suivis

Si une execution est deja active, les messages entrants peuvent etre mis en file d’attente, diriges vers
l’execution en cours, ou collectes pour un tour de suivi.

- Configurer via `messages.queue` (et `messages.queue.byChannel`).
- Modes : `interrupt`, `steer`, `followup`, `collect`, plus des variantes avec backlog.

Details : [Mise en file d’attente](/concepts/queue).

## Streaming, decoupage et lotissement

Le streaming par blocs envoie des reponses partielles au fur et a mesure que le modele produit des blocs de texte.
Le decoupage respecte les limites de texte des canaux et evite de scinder le code balise.

Paramètres de la touche :

- `agents.defaults.blockStreamingDefault` (`on|off`, desactive par defaut)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (lotissement base sur l’inactivite)
- `agents.defaults.humanDelay` (pause de type humaine entre les reponses par blocs)
- Surcharges par canal : `*.blockStreaming` et `*.blockStreamingCoalesce` (les canaux non-Telegram necessitent un `*.blockStreaming: true` explicite)

Details : [Streaming + decoupage](/concepts/streaming).

## Visibilite du raisonnement et tokens

OpenClaw peut exposer ou masquer le raisonnement du modele :

- `/reasoning on|off|stream` controle la visibilite.
- Le contenu de raisonnement compte toujours dans l’utilisation de tokens lorsqu’il est produit par le modele.
- Telegram prend en charge le streaming du raisonnement dans la bulle de brouillon.

Details : [Directives de pensee + raisonnement](/tools/thinking) et [Utilisation des tokens](/token-use).

## Prefixes, fils de discussion et reponses

Le formatage des messages sortants est centralise dans `messages` :

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` et `channels.<channel>.accounts.<id>.responsePrefix` (cascade de prefixes sortants), plus `channels.whatsapp.messagePrefix` (prefixe entrant WhatsApp)
- Fil de reponse via `replyToMode` et des defauts par canal

Details : [Configuration](/gateway/configuration#messages) et la documentation des canaux.
