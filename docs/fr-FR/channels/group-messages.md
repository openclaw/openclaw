---
summary: "Comportement et config pour gestion messages groupe WhatsApp (mentionPatterns partagés entre surfaces)"
read_when:
  - Changement règles messages groupe ou mentions
title: "Messages de Groupe"
---

# Messages de groupe (canal web WhatsApp)

Objectif : laisser Clawd s'asseoir dans les groupes WhatsApp, se réveiller uniquement quand pingé, et garder ce fil séparé de la session DM personnelle.

Note : `agents.list[].groupChat.mentionPatterns` est maintenant utilisé par Telegram/Discord/Slack/iMessage également ; cette doc se concentre sur le comportement spécifique WhatsApp. Pour les configurations multi-agents, définissez `agents.list[].groupChat.mentionPatterns` par agent (ou utilisez `messages.groupChat.mentionPatterns` comme repli global).

## Ce qui est implémenté (2025-12-03)

- Modes d'activation : `mention` (par défaut) ou `always`. `mention` nécessite un ping (vraies @-mentions WhatsApp via `mentionedJids`, motifs regex, ou l'E.164 du bot n'importe où dans le texte). `always` réveille l'agent à chaque message mais il devrait répondre uniquement quand il peut ajouter une valeur significative ; sinon il retourne le jeton silencieux `NO_REPLY`. Les valeurs par défaut peuvent être définies dans la config (`channels.whatsapp.groups`) et remplacées par groupe via `/activation`. Quand `channels.whatsapp.groups` est défini, il agit aussi comme liste d'autorisation de groupe (incluez `"*"` pour autoriser tous).
- Politique de groupe : `channels.whatsapp.groupPolicy` contrôle si les messages de groupe sont acceptés (`open|disabled|allowlist`). `allowlist` utilise `channels.whatsapp.groupAllowFrom` (repli : `channels.whatsapp.allowFrom` explicite). Par défaut `allowlist` (bloqué jusqu'à ce que vous ajoutiez des expéditeurs).
- Sessions par groupe : les clés de session ressemblent à `agent:<agentId>:whatsapp:group:<jid>` donc les commandes comme `/verbose on` ou `/think high` (envoyées comme messages autonomes) sont limitées à ce groupe ; l'état DM personnel n'est pas touché. Les heartbeats sont ignorés pour les fils de groupe.
- Injection de contexte : les messages de groupe **en attente uniquement** (par défaut 50) qui _n'ont pas_ déclenché une exécution sont préfixés sous `[Messages de chat depuis votre dernière réponse - pour contexte]`, avec la ligne déclenchante sous `[Message actuel - répondez à ceci]`. Les messages déjà dans la session ne sont pas réinjectés.
- Affichage de l'expéditeur : chaque lot de groupe se termine maintenant par `[de : Nom Expéditeur (+E164)]` donc Pi sait qui parle.
- Éphémère/affichage unique : nous les déballons avant d'extraire texte/mentions, donc les pings à l'intérieur déclenchent toujours.
- Prompt système de groupe : au premier tour d'une session de groupe (et chaque fois que `/activation` change le mode) nous injectons un court texte dans le prompt système comme `Vous répondez dans le groupe WhatsApp "<sujet>". Membres du groupe : Alice (+44...), Bob (+43...), … Activation : trigger-only … Adressez l'expéditeur spécifique noté dans le contexte du message.` Si les métadonnées ne sont pas disponibles, nous informons quand même l'agent que c'est un chat de groupe.

## Exemple de config (WhatsApp)

Ajoutez un bloc `groupChat` à `~/.openclaw/openclaw.json` pour que les pings display-name fonctionnent même quand WhatsApp supprime le `@` visuel dans le corps du texte :

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

Notes :

- Les regex sont insensibles à la casse ; elles couvrent un ping display-name comme `@openclaw` et le numéro brut avec ou sans `+`/espaces.
- WhatsApp envoie toujours les mentions canoniques via `mentionedJids` quand quelqu'un tape le contact, donc le repli du numéro est rarement nécessaire mais est un filet de sécurité utile.

### Commande d'activation (propriétaire uniquement)

Utilisez la commande de chat de groupe :

- `/activation mention`
- `/activation always`

Seul le numéro propriétaire (de `channels.whatsapp.allowFrom`, ou l'E.164 propre du bot quand non défini) peut changer ceci. Envoyez `/status` comme message autonome dans le groupe pour voir le mode d'activation actuel.

## Comment utiliser

1. Ajoutez votre compte WhatsApp (celui qui exécute OpenClaw) au groupe.
2. Dites `@openclaw …` (ou incluez le numéro). Seuls les expéditeurs de la liste d'autorisation peuvent le déclencher sauf si vous définissez `groupPolicy: "open"`.
3. Le prompt de l'agent inclura le contexte de groupe récent plus le marqueur `[de : …]` final pour qu'il puisse adresser la bonne personne.
4. Les directives au niveau session (`/verbose on`, `/think high`, `/new` ou `/reset`, `/compact`) s'appliquent uniquement à la session de ce groupe ; envoyez-les comme messages autonomes pour qu'ils s'enregistrent. Votre session DM personnelle reste indépendante.

## Test / vérification

- Smoke manuel :
  - Envoyez un ping `@openclaw` dans le groupe et confirmez une réponse qui référence le nom de l'expéditeur.
  - Envoyez un deuxième ping et vérifiez que le bloc d'historique est inclus puis effacé au tour suivant.
- Vérifiez les journaux de la passerelle (exécutez avec `--verbose`) pour voir les entrées `inbound web message` montrant `from: <groupJid>` et le suffixe `[de : …]`.

## Considérations connues

- Les heartbeats sont intentionnellement ignorés pour les groupes pour éviter les diffusions bruyantes.
- La suppression d'écho utilise la chaîne de lot combinée ; si vous envoyez un texte identique deux fois sans mentions, seule la première obtiendra une réponse.
- Les entrées du magasin de session apparaîtront comme `agent:<agentId>:whatsapp:group:<jid>` dans le magasin de session (`~/.openclaw/agents/<agentId>/sessions/sessions.json` par défaut) ; une entrée manquante signifie simplement que le groupe n'a pas encore déclenché d'exécution.
- Les indicateurs de frappe dans les groupes suivent `agents.defaults.typingMode` (par défaut : `message` quand non mentionné).
