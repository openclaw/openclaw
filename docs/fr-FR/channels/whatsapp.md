---
summary: "Support du canal WhatsApp, contrôles d'accès, comportement de livraison et opérations"
read_when:
  - Travail sur le comportement du canal WhatsApp/web ou le routage de la boîte de réception
title: "WhatsApp"
---

# WhatsApp (Canal Web)

Statut : prêt pour la production via WhatsApp Web (Baileys). La Passerelle gère la ou les session(s) liée(s).

<CardGroup cols={3}>
  <Card title="Appairage" icon="link" href="/fr-FR/channels/pairing">
    La politique DM par défaut est l'appairage pour les expéditeurs inconnus.
  </Card>
  <Card title="Dépannage des canaux" icon="wrench" href="/fr-FR/channels/troubleshooting">
    Diagnostics inter-canaux et procédures de réparation.
  </Card>
  <Card title="Configuration de la Passerelle" icon="settings" href="/fr-FR/gateway/configuration">
    Modèles et exemples de configuration des canaux complets.
  </Card>
</CardGroup>

## Configuration rapide

<Steps>
  <Step title="Configurer la politique d'accès WhatsApp">

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

  </Step>

  <Step title="Lier WhatsApp (QR)">

```bash
openclaw channels login --channel whatsapp
```

    Pour un compte spécifique :

```bash
openclaw channels login --channel whatsapp --account travail
```

  </Step>

  <Step title="Démarrer la passerelle">

```bash
openclaw gateway
```

  </Step>

  <Step title="Approuver la première demande d'appairage (si mode appairage activé)">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    Les demandes d'appairage expirent après 1 heure. Les demandes en attente sont limitées à 3 par canal.

  </Step>
</Steps>

<Note>
OpenClaw recommande d'utiliser WhatsApp sur un numéro séparé quand c'est possible. (Les métadonnées du canal et le flux de configuration initiale sont optimisés pour cette configuration, mais les configurations avec numéro personnel sont également prises en charge.)
</Note>

## Schémas de déploiement

<AccordionGroup>
  <Accordion title="Numéro dédié (recommandé)">
    C'est le mode opérationnel le plus propre :

    - identité WhatsApp séparée pour OpenClaw
    - listes blanches DM et limites de routage plus claires
    - risque plus faible de confusion avec l'auto-discussion

    Modèle de politique minimale :

    ```json5
    {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Solution de secours avec numéro personnel">
    La configuration initiale prend en charge le mode numéro personnel et écrit une configuration de base adaptée à l'auto-discussion :

    - `dmPolicy: "allowlist"`
    - `allowFrom` inclut votre numéro personnel
    - `selfChatMode: true`

    Au runtime, les protections d'auto-discussion se basent sur le numéro personnel lié et `allowFrom`.

  </Accordion>

  <Accordion title="Portée du canal WhatsApp Web uniquement">
    Le canal de la plateforme de messagerie est basé sur WhatsApp Web (`Baileys`) dans l'architecture de canal OpenClaw actuelle.

    Il n'y a pas de canal de messagerie WhatsApp Twilio séparé dans le registre de canaux de discussion intégré.

  </Accordion>
</AccordionGroup>

## Modèle d'exécution

- La Passerelle possède le socket WhatsApp et la boucle de reconnexion.
- Les envois sortants nécessitent un listener WhatsApp actif pour le compte cible.
- Les discussions de statut et de diffusion sont ignorées (`@status`, `@broadcast`).
- Les discussions directes utilisent les règles de session DM (`session.dmScope` ; par défaut `main` regroupe les DM dans la session principale de l'agent).
- Les sessions de groupe sont isolées (`agent:<agentId>:whatsapp:group:<jid>`).

## Contrôle d'accès et activation

<Tabs>
  <Tab title="Politique DM">
    `channels.whatsapp.dmPolicy` contrôle l'accès aux discussions directes :

    - `pairing` (par défaut)
    - `allowlist`
    - `open` (nécessite que `allowFrom` inclue `"*"`)
    - `disabled`

    `allowFrom` accepte les numéros au format E.164 (normalisés en interne).

    Remplacement multi-compte : `channels.whatsapp.accounts.<id>.dmPolicy` (et `allowFrom`) a la priorité sur les valeurs par défaut au niveau du canal pour ce compte.

    Détails du comportement au runtime :

    - les appairages sont persistés dans le magasin de listes blanches du canal et fusionnés avec le `allowFrom` configuré
    - si aucune liste blanche n'est configurée, le numéro personnel lié est autorisé par défaut
    - les DM sortants `fromMe` ne sont jamais auto-appairés

  </Tab>

  <Tab title="Politique de groupe + listes blanches">
    L'accès aux groupes comporte deux couches :

    1. **Liste blanche d'appartenance au groupe** (`channels.whatsapp.groups`)
       - si `groups` est omis, tous les groupes sont éligibles
       - si `groups` est présent, il agit comme une liste blanche de groupe (`"*"` autorisé)

    2. **Politique d'expéditeur de groupe** (`channels.whatsapp.groupPolicy` + `groupAllowFrom`)
       - `open` : liste blanche d'expéditeur contournée
       - `allowlist` : l'expéditeur doit correspondre à `groupAllowFrom` (ou `*`)
       - `disabled` : bloquer tous les messages entrants de groupe

    Solution de secours pour la liste blanche d'expéditeurs :

    - si `groupAllowFrom` n'est pas défini, le runtime se rabat sur `allowFrom` quand disponible

    Note : si aucun bloc `channels.whatsapp` n'existe du tout, la politique de groupe de secours au runtime est effectivement `open`.

  </Tab>

  <Tab title="Mentions + /activation">
    Les réponses de groupe nécessitent une mention par défaut.

    La détection de mention inclut :

    - mentions WhatsApp explicites de l'identité du bot
    - modèles regex de mention configurés (`agents.list[].groupChat.mentionPatterns`, solution de secours `messages.groupChat.mentionPatterns`)
    - détection implicite de réponse au bot (l'expéditeur de la réponse correspond à l'identité du bot)

    Commande d'activation au niveau de la session :

    - `/activation mention`
    - `/activation always`

    `activation` met à jour l'état de la session (pas la config globale). Elle est protégée par le propriétaire.

  </Tab>
</Tabs>

## Comportement avec numéro personnel et auto-discussion

Lorsque le numéro personnel lié est également présent dans `allowFrom`, les protections d'auto-discussion WhatsApp s'activent :

- ignorer les accusés de lecture pour les tours d'auto-discussion
- ignorer le comportement de déclenchement automatique mention-JID qui vous ferait ping vous-même
- si `messages.responsePrefix` n'est pas défini, les réponses d'auto-discussion utilisent par défaut `[{identity.name}]` ou `[openclaw]`

## Normalisation des messages et contexte

<AccordionGroup>
  <Accordion title="Enveloppe entrante + contexte de réponse">
    Les messages WhatsApp entrants sont encapsulés dans l'enveloppe entrante partagée.

    Si une réponse citée existe, le contexte est ajouté sous cette forme :

    ```text
    [En réponse à <expéditeur> id:<stanzaId>]
    <corps cité ou espace réservé média>
    [/En réponse]
    ```

    Les champs de métadonnées de réponse sont également remplis quand disponibles (`ReplyToId`, `ReplyToBody`, `ReplyToSender`, JID de l'expéditeur/E.164).

  </Accordion>

  <Accordion title="Espaces réservés média et extraction localisation/contact">
    Les messages entrants contenant uniquement des médias sont normalisés avec des espaces réservés tels que :

    - `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

    Les charges utiles de localisation et de contact sont normalisées en contexte textuel avant le routage.

  </Accordion>

  <Accordion title="Injection d'historique de groupe en attente">
    Pour les groupes, les messages non traités peuvent être mis en mémoire tampon et injectés comme contexte lorsque le bot est finalement déclenché.

    - limite par défaut : `50`
    - config : `channels.whatsapp.historyLimit`
    - solution de secours : `messages.groupChat.historyLimit`
    - `0` désactive

    Marqueurs d'injection :

    - `[Messages de discussion depuis votre dernière réponse - pour contexte]`
    - `[Message actuel - répondez à celui-ci]`

  </Accordion>

  <Accordion title="Accusés de lecture">
    Les accusés de lecture sont activés par défaut pour les messages WhatsApp entrants acceptés.

    Désactiver globalement :

    ```json5
    {
      channels: {
        whatsapp: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    Remplacement par compte :

    ```json5
    {
      channels: {
        whatsapp: {
          accounts: {
            travail: {
              sendReadReceipts: false,
            },
          },
        },
      },
    }
    ```

    Les tours d'auto-discussion ignorent les accusés de lecture même lorsqu'ils sont activés globalement.

  </Accordion>
</AccordionGroup>

## Livraison, découpage et média

<AccordionGroup>
  <Accordion title="Découpage de texte">
    - limite de morceau par défaut : `channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - le mode `newline` préfère les limites de paragraphe (lignes vides), puis se rabat sur un découpage sécurisé par longueur
  </Accordion>

  <Accordion title="Comportement média sortant">
    - prend en charge les charges utiles image, vidéo, audio (note vocale PTT) et document
    - `audio/ogg` est réécrit en `audio/ogg; codecs=opus` pour la compatibilité des notes vocales
    - la lecture de GIF animés est prise en charge via `gifPlayback: true` sur les envois vidéo
    - les légendes sont appliquées au premier élément média lors de l'envoi de charges utiles de réponse multi-média
    - la source média peut être HTTP(S), `file://` ou des chemins locaux
  </Accordion>

  <Accordion title="Limites de taille média et comportement de secours">
    - plafond d'enregistrement média entrant : `channels.whatsapp.mediaMaxMb` (par défaut `50`)
    - plafond média sortant pour les réponses automatiques : `agents.defaults.mediaMaxMb` (par défaut `5MB`)
    - les images sont auto-optimisées (balayage redimensionnement/qualité) pour s'adapter aux limites
    - en cas d'échec d'envoi média, la solution de secours du premier élément envoie un avertissement texte au lieu de supprimer silencieusement la réponse
  </Accordion>
</AccordionGroup>

## Réactions d'accusé de réception

WhatsApp prend en charge les réactions d'accusé immédiates à la réception entrante via `channels.whatsapp.ackReaction`.

```json5
{
  channels: {
    whatsapp: {
      ackReaction: {
        emoji: "👀",
        direct: true,
        group: "mentions", // always | mentions | never
      },
    },
  },
}
```

Notes de comportement :

- envoyé immédiatement après l'acceptation entrante (pré-réponse)
- les échecs sont enregistrés mais ne bloquent pas la livraison normale de la réponse
- le mode groupe `mentions` réagit aux tours déclenchés par mention ; l'activation de groupe `always` agit comme contournement pour cette vérification
- WhatsApp utilise `channels.whatsapp.ackReaction` (l'ancien `messages.ackReaction` n'est pas utilisé ici)

## Multi-compte et identifiants

<AccordionGroup>
  <Accordion title="Sélection de compte et valeurs par défaut">
    - les ids de compte proviennent de `channels.whatsapp.accounts`
    - sélection de compte par défaut : `default` si présent, sinon premier id de compte configuré (trié)
    - les ids de compte sont normalisés en interne pour la recherche
  </Accordion>

  <Accordion title="Chemins d'identifiants et compatibilité héritée">
    - chemin d'authentification actuel : `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - fichier de sauvegarde : `creds.json.bak`
    - l'authentification par défaut héritée dans `~/.openclaw/credentials/` est toujours reconnue/migrée pour les flux de compte par défaut
  </Accordion>

  <Accordion title="Comportement de déconnexion">
    `openclaw channels logout --channel whatsapp [--account <id>]` efface l'état d'authentification WhatsApp pour ce compte.

    Dans les répertoires d'authentification hérités, `oauth.json` est préservé tandis que les fichiers d'authentification Baileys sont supprimés.

  </Accordion>
</AccordionGroup>

## Outils, actions et écritures de configuration

- Le support d'outil d'agent inclut l'action de réaction WhatsApp (`react`).
- Portes d'action :
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- Les écritures de configuration initiées par canal sont activées par défaut (désactiver via `channels.whatsapp.configWrites=false`).

## Dépannage

<AccordionGroup>
  <Accordion title="Non lié (QR requis)">
    Symptôme : le statut du canal signale non lié.

    Solution :

    ```bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

  </Accordion>

  <Accordion title="Lié mais déconnecté / boucle de reconnexion">
    Symptôme : compte lié avec déconnexions répétées ou tentatives de reconnexion.

    Solution :

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    Si nécessaire, reliez avec `channels login`.

  </Accordion>

  <Accordion title="Pas de listener actif lors de l'envoi">
    Les envois sortants échouent rapidement lorsqu'aucun listener de passerelle actif n'existe pour le compte cible.

    Assurez-vous que la passerelle est en cours d'exécution et que le compte est lié.

  </Accordion>

  <Accordion title="Messages de groupe ignorés de manière inattendue">
    Vérifiez dans cet ordre :

    - `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - entrées de liste blanche `groups`
    - contrôle de mention (`requireMention` + modèles de mention)

  </Accordion>

  <Accordion title="Avertissement runtime Bun">
    Le runtime de passerelle WhatsApp doit utiliser Node. Bun est signalé comme incompatible pour un fonctionnement stable de la passerelle WhatsApp/Telegram.
  </Accordion>
</AccordionGroup>

## Pointeurs de référence de configuration

Référence principale :

- [Référence de configuration - WhatsApp](/fr-FR/gateway/configuration-reference#whatsapp)

Champs WhatsApp à fort signal :

- accès : `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`
- livraison : `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `sendReadReceipts`, `ackReaction`
- multi-compte : `accounts.<id>.enabled`, `accounts.<id>.authDir`, remplacements au niveau du compte
- opérations : `configWrites`, `debounceMs`, `web.enabled`, `web.heartbeatSeconds`, `web.reconnect.*`
- comportement de session : `session.dmScope`, `historyLimit`, `dmHistoryLimit`, `dms.<id>.historyLimit`

## Connexe

- [Appairage](/fr-FR/channels/pairing)
- [Routage de canal](/fr-FR/channels/channel-routing)
- [Dépannage](/fr-FR/channels/troubleshooting)
