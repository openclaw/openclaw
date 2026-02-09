---
summary: "Comportement et configuration de la gestion des messages de groupe WhatsApp (les mentionPatterns sont partagés entre les surfaces)"
read_when:
  - Modification des règles de messages de groupe ou des mentions
title: "Messages de groupe"
---

# Messages de groupe (canal web WhatsApp)

Objectif : permettre à Clawd d’être présent dans des groupes WhatsApp, de se réveiller uniquement lorsqu’il est sollicité, et de garder ce fil séparé de la session de message privé personnelle.

Remarque : `agents.list[].groupChat.mentionPatterns` est désormais utilisé par Telegram/Discord/Slack/iMessage également ; ce document se concentre sur le comportement spécifique à WhatsApp. Pour les configurations multi‑agents, définissez `agents.list[].groupChat.mentionPatterns` par agent (ou utilisez `messages.groupChat.mentionPatterns` comme solution de repli globale).

## Ce qui est implémenté (2025-12-03)

- Modes d’activation : `mention` (par défaut) ou `always`. `mention` nécessite un ping (vraies @mentions WhatsApp via `mentionedJids`, motifs regex, ou l’E.164 du bot n’importe où dans le texte). `always` réveille l’agent à chaque message, mais il ne doit répondre que lorsqu’il peut apporter une valeur significative ; sinon, il renvoie le jeton silencieux `NO_REPLY`. Les valeurs par défaut peuvent être définies dans la configuration (`channels.whatsapp.groups`) et surchargées par groupe via `/activation`. Lorsque `channels.whatsapp.groups` est défini, il agit aussi comme une liste d’autorisation de groupe (inclure `"*"` pour tout autoriser).
- Politique de groupe : `channels.whatsapp.groupPolicy` contrôle si les messages de groupe sont acceptés (`open|disabled|allowlist`). `allowlist` utilise `channels.whatsapp.groupAllowFrom` (solution de repli : `channels.whatsapp.allowFrom` explicite). La valeur par défaut est `allowlist` (bloqué jusqu’à l’ajout d’expéditeurs).
- Sessions par groupe : les clés de session ressemblent à `agent:<agentId>:whatsapp:group:<jid>`, de sorte que des commandes telles que `/verbose on` ou `/think high` (envoyées comme messages autonomes) sont limitées à ce groupe ; l’état des messages privés personnels reste intact. Les heartbeats sont ignorés pour les fils de groupe.
- Injection de contexte : les messages de groupe **en attente uniquement** (50 par défaut) qui _n’ont pas_ déclenché une exécution sont préfixés sous `[Chat messages since your last reply - for context]`, avec la ligne déclenchante sous `[Current message - respond to this]`. Les messages déjà présents dans la session ne sont pas réinjectés.
- Mise en évidence de l’expéditeur : chaque lot de groupe se termine désormais par `[from: Sender Name (+E164)]` afin que Pi sache qui parle.
- Éphémère / « voir une fois » : nous les déballons avant d’extraire le texte/les mentions, de sorte que les pings à l’intérieur déclenchent toujours.
- Invite système de groupe : au premier tour d’une session de groupe (et chaque fois que `/activation` change le mode), nous injectons un court texte dans l’invite système, comme `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`. Si les métadonnées ne sont pas disponibles, nous indiquons quand même à l’agent qu’il s’agit d’un chat de groupe.

## Exemple de configuration (WhatsApp)

Ajoutez un bloc `groupChat` à `~/.openclaw/openclaw.json` afin que les pings par nom d’affichage fonctionnent même lorsque WhatsApp supprime le `@` visuel dans le corps du texte :

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Remarques :

- Les regex sont insensibles à la casse ; elles couvrent un ping par nom d’affichage comme `@openclaw` et le numéro brut avec ou sans `+`/espaces.
- WhatsApp envoie toujours des mentions canoniques via `mentionedJids` lorsqu’une personne touche le contact ; la solution de repli par numéro est donc rarement nécessaire, mais constitue un filet de sécurité utile.

### Commande d’activation (réservée au propriétaire)

Utilisez la commande de chat de groupe :

- `/activation mention`
- `/activation always`

Seul le numéro du propriétaire (depuis `channels.whatsapp.allowFrom`, ou l’E.164 du bot lorsqu’il n’est pas défini) peut modifier cela. Envoyez `/status` comme message autonome dans le groupe pour voir le mode d’activation actuel.

## Comment utiliser

1. Ajoutez votre compte WhatsApp (celui qui exécute OpenClaw) au groupe.
2. Dites `@openclaw …` (ou incluez le numéro). Seuls les expéditeurs autorisés peuvent le déclencher, sauf si vous définissez `groupPolicy: "open"`.
3. L’invite de l’agent inclura le contexte récent du groupe ainsi que le marqueur final `[from: …]` afin qu’il puisse s’adresser à la bonne personne.
4. Les directives au niveau de la session (`/verbose on`, `/think high`, `/new` ou `/reset`, `/compact`) s’appliquent uniquement à la session de ce groupe ; envoyez‑les comme messages autonomes pour qu’elles soient prises en compte. Votre session de message privé personnelle reste indépendante.

## Tests / vérification

- Fumée manuelle:
  - Envoyez un ping `@openclaw` dans le groupe et confirmez une réponse qui fait référence au nom de l’expéditeur.
  - Envoyez un second ping et vérifiez que le bloc d’historique est inclus puis effacé au tour suivant.
- Vérifiez les journaux de la Gateway (passerelle) (exécutez avec `--verbose`) pour voir des entrées `inbound web message` montrant `from: <groupJid>` et le suffixe `[from: …]`.

## Points connus à considérer

- Les heartbeats sont volontairement ignorés pour les groupes afin d’éviter des diffusions bruyantes.
- La suppression d’écho utilise la chaîne de lot combinée ; si vous envoyez un texte identique deux fois sans mentions, seule la première obtiendra une réponse.
- Les entrées du magasin de sessions apparaîtront comme `agent:<agentId>:whatsapp:group:<jid>` dans le magasin de sessions (`~/.openclaw/agents/<agentId>/sessions/sessions.json` par défaut) ; une entrée manquante signifie simplement que le groupe n’a pas encore déclenché d’exécution.
- Les indicateurs de saisie dans les groupes suivent `agents.defaults.typingMode` (par défaut : `message` lorsqu’il n’y a pas de mention).
