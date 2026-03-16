---
summary: "Support iMessage hérité via imsg (JSON-RPC sur stdio). Les nouvelles installations devraient utiliser BlueBubbles."
read_when:
  - Configuration du support iMessage
  - Débogage d'envoi/réception iMessage
title: "iMessage"
---

# iMessage (hérité : imsg)

<Warning>
Pour les nouveaux déploiements iMessage, utilisez <a href="/fr-FR/channels/bluebubbles">BlueBubbles</a>.

L'intégration `imsg` est héritée et peut être supprimée dans une future version.
</Warning>

Statut : intégration CLI externe héritée. La Passerelle génère `imsg rpc` et communique sur JSON-RPC sur stdio (pas de daemon/port séparé).

<CardGroup cols={3}>
  <Card title="BlueBubbles (recommandé)" icon="message-circle" href="/fr-FR/channels/bluebubbles">
    Chemin iMessage préféré pour les nouvelles installations.
  </Card>
  <Card title="Appairage" icon="link" href="/fr-FR/channels/pairing">
    Les DM iMessage utilisent le mode d'appairage par défaut.
  </Card>
  <Card title="Référence de configuration" icon="settings" href="/fr-FR/gateway/configuration-reference#imessage">
    Référence complète des champs iMessage.
  </Card>
</CardGroup>

## Configuration rapide

<Tabs>
  <Tab title="Mac local (chemin rapide)">
    <Steps>
      <Step title="Installer et vérifier imsg">

```bash
brew install steipete/tap/imsg
imsg rpc --help
```

      </Step>

      <Step title="Configurer OpenClaw">

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<vous>/Library/Messages/chat.db",
    },
  },
}
```

      </Step>

      <Step title="Démarrer la passerelle">

```bash
openclaw gateway
```

      </Step>

      <Step title="Approuver le premier appairage DM (dmPolicy par défaut)">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

        Les demandes d'appairage expirent après 1 heure.
      </Step>
    </Steps>

  </Tab>

  <Tab title="Mac distant via SSH">
    OpenClaw nécessite seulement un `cliPath` compatible stdio, donc vous pouvez pointer `cliPath` vers un script wrapper qui SSH vers un Mac distant et exécute `imsg`.

```bash
#!/usr/bin/env bash
exec ssh -T hôte-passerelle imsg "$@"
```

    Configuration recommandée quand les pièces jointes sont activées :

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "utilisateur@hôte-passerelle", // utilisé pour récupérations pièces jointes SCP
      includeAttachments: true,
    },
  },
}
```

    Si `remoteHost` n'est pas défini, OpenClaw tente de le détecter automatiquement en analysant le script wrapper SSH.

  </Tab>
</Tabs>

## Exigences et permissions (macOS)

- Messages doit être connecté sur le Mac exécutant `imsg`.
- L'accès disque complet est requis pour le contexte de processus exécutant OpenClaw/`imsg` (accès DB Messages).
- La permission d'automation est requise pour envoyer des messages via Messages.app.

<Tip>
Les permissions sont accordées par contexte de processus. Si la passerelle s'exécute en headless (LaunchAgent/SSH), exécutez une commande interactive unique dans ce même contexte pour déclencher les invites :

```bash
imsg chats --limit 1
# ou
imsg send <handle> "test"
```

</Tip>

## Contrôle d'accès et routage

<Tabs>
  <Tab title="Politique DM">
    `channels.imessage.dmPolicy` contrôle les messages directs :

    - `pairing` (par défaut)
    - `allowlist`
    - `open` (nécessite que `allowFrom` inclue `"*"`)
    - `disabled`

    Champ allowlist : `channels.imessage.allowFrom`.

    Les entrées allowlist peuvent être des handles ou des cibles de chat (`chat_id:*`, `chat_guid:*`, `chat_identifier:*`).

  </Tab>

  <Tab title="Politique de groupe + mentions">
    `channels.imessage.groupPolicy` contrôle la gestion de groupe :

    - `allowlist` (par défaut quand configuré)
    - `open`
    - `disabled`

    Allowlist expéditeur de groupe : `channels.imessage.groupAllowFrom`.

    Repli runtime : si `groupAllowFrom` n'est pas défini, les vérifications d'expéditeur de groupe iMessage se replient sur `allowFrom` quand disponible.

    Contrôle de mention pour les groupes :

    - iMessage n'a pas de métadonnées de mention natives
    - la détection de mention utilise des motifs regex (`agents.list[].groupChat.mentionPatterns`, repli `messages.groupChat.mentionPatterns`)
    - sans motifs configurés, le contrôle de mention ne peut pas être appliqué

    Les commandes de contrôle d'expéditeurs autorisés peuvent contourner le contrôle de mention dans les groupes.

  </Tab>

  <Tab title="Sessions et réponses déterministes">
    - Les DM utilisent le routage direct ; les groupes utilisent le routage de groupe.
    - Avec le `session.dmScope=main` par défaut, les DM iMessage s'effondrent dans la session principale de l'agent.
    - Les sessions de groupe sont isolées (`agent:<agentId>:imessage:group:<chat_id>`).
    - Les réponses retournent vers iMessage en utilisant les métadonnées de canal/cible d'origine.

    Comportement de fil similaire à groupe :

    Certains fils iMessage multi-participants peuvent arriver avec `is_group=false`.
    Si ce `chat_id` est explicitement configuré sous `channels.imessage.groups`, OpenClaw le traite comme du trafic de groupe (contrôle de groupe + isolation de session de groupe).

  </Tab>
</Tabs>

## Modèles de déploiement

<AccordionGroup>
  <Accordion title="Utilisateur macOS bot dédié (identité iMessage séparée)">
    Utilisez un Apple ID dédié et un utilisateur macOS pour que le trafic bot soit isolé de votre profil Messages personnel.

    Flux typique :

    1. Créez/connectez un utilisateur macOS dédié.
    2. Connectez-vous à Messages avec l'Apple ID du bot dans cet utilisateur.
    3. Installez `imsg` dans cet utilisateur.
    4. Créez un wrapper SSH pour qu'OpenClaw puisse exécuter `imsg` dans ce contexte utilisateur.
    5. Pointez `channels.imessage.accounts.<id>.cliPath` et `.dbPath` vers ce profil utilisateur.

    La première exécution peut nécessiter des approbations GUI (Automation + Accès disque complet) dans cette session utilisateur bot.

  </Accordion>

  <Accordion title="Mac distant via Tailscale (exemple)">
    Topologie commune :

    - la passerelle s'exécute sur Linux/VM
    - iMessage + `imsg` s'exécutent sur un Mac dans votre tailnet
    - le wrapper `cliPath` utilise SSH pour exécuter `imsg`
    - `remoteHost` active les récupérations de pièces jointes SCP

    Exemple :

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

    Utilisez les clés SSH pour que SSH et SCP soient non-interactifs.

  </Accordion>

  <Accordion title="Modèle multi-compte">
    iMessage supporte la config par compte sous `channels.imessage.accounts`.

    Chaque compte peut remplacer des champs tels que `cliPath`, `dbPath`, `allowFrom`, `groupPolicy`, `mediaMaxMb`, et paramètres d'historique.

  </Accordion>
</AccordionGroup>

## Média, découpage et cibles de livraison

<AccordionGroup>
  <Accordion title="Pièces jointes et médias">
    - l'ingestion de pièce jointe entrante est optionnelle : `channels.imessage.includeAttachments`
    - les chemins de pièce jointe distants peuvent être récupérés via SCP quand `remoteHost` est défini
    - la taille de média sortant utilise `channels.imessage.mediaMaxMb` (par défaut 16 MB)
  </Accordion>

  <Accordion title="Découpage sortant">
    - limite de morceau de texte : `channels.imessage.textChunkLimit` (par défaut 4000)
    - mode de morceau : `channels.imessage.chunkMode`
      - `length` (par défaut)
      - `newline` (séparation paragraphe d'abord)
  </Accordion>

  <Accordion title="Formats d'adressage">
    Cibles explicites préférées :

    - `chat_id:123` (recommandé pour routage stable)
    - `chat_guid:...`
    - `chat_identifier:...`

    Les cibles de handle sont aussi supportées :

    - `imessage:+1555...`
    - `sms:+1555...`
    - `utilisateur@exemple.com`

```bash
imsg chats --limit 20
```

  </Accordion>
</AccordionGroup>

## Écritures de config

iMessage permet les écritures de config initiées par canal par défaut (pour `/config set|unset` quand `commands.config: true`).

Désactiver :

```json5
{
  channels: {
    imessage: {
      configWrites: false,
    },
  },
}
```

## Dépannage

<AccordionGroup>
  <Accordion title="imsg introuvable ou RPC non supporté">
    Validez le binaire et le support RPC :

```bash
imsg rpc --help
openclaw channels status --probe
```

    Si probe signale RPC non supporté, mettez à jour `imsg`.

  </Accordion>

  <Accordion title="Les DM sont ignorés">
    Vérifiez :

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - approbations d'appairage (`openclaw pairing list imessage`)

  </Accordion>

  <Accordion title="Les messages de groupe sont ignorés">
    Vérifiez :

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - comportement allowlist `channels.imessage.groups`
    - configuration de motif de mention (`agents.list[].groupChat.mentionPatterns`)

  </Accordion>

  <Accordion title="Les pièces jointes distantes échouent">
    Vérifiez :

    - `channels.imessage.remoteHost`
    - auth clé SSH/SCP depuis l'hôte passerelle
    - lisibilité du chemin distant sur le Mac exécutant Messages

  </Accordion>

  <Accordion title="Invites de permission macOS manquées">
    Réexécutez dans un terminal GUI interactif dans le même contexte utilisateur/session et approuvez les invites :

```bash
imsg chats --limit 1
imsg send <handle> "test"
```

    Confirmez que l'Accès disque complet + Automation sont accordés pour le contexte de processus qui exécute OpenClaw/`imsg`.

  </Accordion>
</AccordionGroup>

## Pointeurs de référence de configuration

- [Référence de configuration - iMessage](/fr-FR/gateway/configuration-reference#imessage)
- [Configuration de Passerelle](/fr-FR/gateway/configuration)
- [Appairage](/fr-FR/channels/pairing)
- [BlueBubbles](/fr-FR/channels/bluebubbles)
