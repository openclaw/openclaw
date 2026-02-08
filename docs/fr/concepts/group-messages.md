---
summary: "Comportement et configuration de la gestion des messages de groupe WhatsApp (les mentionPatterns sont partagés entre les surfaces)"
read_when:
  - Modification des règles de messages de groupe ou des mentions
title: "Messages de groupe"
x-i18n:
  source_path: concepts/group-messages.md
  source_hash: 181a72f12f5021af
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:01:16Z
---

# Messages de groupe (canal WhatsApp Web)

Objectif : permettre à Clawd de rester dans des groupes WhatsApp, de ne se réveiller que lorsqu’il est sollicité, et de garder ce fil séparé de la session de Messages prives personnelle.

Remarque : `agents.list[].groupChat.mentionPatterns` est désormais utilisé par Telegram/Discord/Slack/iMessage également ; ce document se concentre sur le comportement spécifique à WhatsApp. Pour les configurations multi-agents, définissez `agents.list[].groupChat.mentionPatterns` par agent (ou utilisez `messages.groupChat.mentionPatterns` comme repli global).

## Ce qui est implémenté (2025-12-03)

- Modes d’activation : `mention` (par défaut) ou `always`. `mention` nécessite un ping (véritables @-mentions WhatsApp via `mentionedJids`, motifs regex, ou l’E.164 du bot n’importe où dans le texte). `always` réveille l’agent à chaque message, mais il ne doit répondre que lorsqu’il peut apporter une valeur significative ; sinon, il renvoie le jeton silencieux `NO_REPLY`. Les valeurs par défaut peuvent être définies dans la configuration (`channels.whatsapp.groups`) et surchargées par groupe via `/activation`. Lorsque `channels.whatsapp.groups` est défini, il agit aussi comme une liste d’autorisation de groupe (inclure `"*"` pour tout autoriser).
- Politique de groupe : `channels.whatsapp.groupPolicy` contrôle si les messages de groupe sont acceptés (`open|disabled|allowlist`). `allowlist` utilise `channels.whatsapp.groupAllowFrom` (repli : `channels.whatsapp.allowFrom` explicite). La valeur par défaut est `allowlist` (bloqué jusqu’à ce que vous ajoutiez des expéditeurs).
- Sessions par groupe : les clés de session ressemblent à `agent:<agentId>:whatsapp:group:<jid>`, de sorte que des commandes telles que `/verbose on` ou `/think high` (envoyées comme messages autonomes) sont limitées à ce groupe ; l’état des Messages prives personnels n’est pas affecté. Les battements de cœur sont ignorés pour les fils de groupe.
- Injection de contexte : les messages de groupe **en attente uniquement** (50 par défaut) qui _n’ont pas_ déclenché d’exécution sont préfixés sous `[Chat messages since your last reply - for context]`, avec la ligne déclencheuse sous `[Current message - respond to this]`. Les messages déjà dans la session ne sont pas réinjectés.
- Exposition de l’expéditeur : chaque lot de groupe se termine désormais par `[from: Sender Name (+E164)]` afin que Pi sache qui parle.
- Éphémère / « vue unique » : nous les déballons avant d’extraire le texte/les mentions, de sorte que les pings à l’intérieur déclenchent toujours.
- Invite système de groupe : au premier tour d’une session de groupe (et chaque fois que `/activation` change le mode), nous injectons un court encart dans l’invite système, comme `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`. Si les métadonnées ne sont pas disponibles, nous indiquons quand même à l’agent qu’il s’agit d’un chat de groupe.

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

Notes :

- Les regex sont insensibles à la casse ; elles couvrent un ping par nom d’affichage comme `@openclaw` ainsi que le numéro brut avec ou sans `+`/espaces.
- WhatsApp envoie toujours des mentions canoniques via `mentionedJids` lorsqu’une personne touche le contact ; le repli sur le numéro est donc rarement nécessaire, mais constitue un filet de sécurité utile.

### Commande d’activation (réservée au propriétaire)

Utilisez la commande de chat de groupe :

- `/activation mention`
- `/activation always`

Seul le numéro du propriétaire (issu de `channels.whatsapp.allowFrom`, ou l’E.164 du bot s’il n’est pas défini) peut modifier cela. Envoyez `/status` comme message autonome dans le groupe pour voir le mode d’activation actuel.

## Comment utiliser

1. Ajoutez votre compte WhatsApp (celui qui exécute OpenClaw) au groupe.
2. Dites `@openclaw …` (ou incluez le numéro). Seuls les expéditeurs autorisés peuvent le déclencher, sauf si vous définissez `groupPolicy: "open"`.
3. L’invite de l’agent inclura le contexte récent du groupe ainsi que le marqueur final `[from: …]` afin qu’il puisse s’adresser à la bonne personne.
4. Les directives au niveau de la session (`/verbose on`, `/think high`, `/new` ou `/reset`, `/compact`) s’appliquent uniquement à la session de ce groupe ; envoyez-les comme messages autonomes pour qu’elles soient prises en compte. Votre session de Messages prives personnelle reste indépendante.

## Tests / vérification

- Tests manuels rapides :
  - Envoyez un ping `@openclaw` dans le groupe et confirmez une réponse qui référence le nom de l’expéditeur.
  - Envoyez un second ping et vérifiez que le bloc d’historique est inclus puis effacé au tour suivant.
- Vérifiez les journaux de la Gateway (passerelle) (exécutez avec `--verbose`) pour voir les entrées `inbound web message` affichant `from: <groupJid>` et le suffixe `[from: …]`.

## Points à connaître

- Les battements de cœur sont volontairement ignorés pour les groupes afin d’éviter des diffusions bruyantes.
- La suppression d’écho utilise la chaîne combinée du lot ; si vous envoyez deux fois un texte identique sans mentions, seule la première occurrence recevra une réponse.
- Les entrées du magasin de sessions apparaîtront sous la forme `agent:<agentId>:whatsapp:group:<jid>` dans le magasin de sessions (`~/.openclaw/agents/<agentId>/sessions/sessions.json` par défaut) ; une entrée manquante signifie simplement que le groupe n’a pas encore déclenché d’exécution.
- Les indicateurs de saisie dans les groupes suivent `agents.defaults.typingMode` (par défaut : `message` lorsqu’il n’y a pas de mention).
