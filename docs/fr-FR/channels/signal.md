---
summary: "Support Signal via signal-cli (JSON-RPC + SSE), chemins de configuration et modèle de numéro"
read_when:
  - Configuration du support Signal
  - Débogage d'envoi/réception Signal
title: "Signal"
---

# Signal (signal-cli)

Statut : intégration CLI externe. La Passerelle communique avec `signal-cli` via HTTP JSON-RPC + SSE.

## Prérequis

- OpenClaw installé sur votre serveur (flux Linux testé sur Ubuntu 24).
- `signal-cli` disponible sur l'hôte où la passerelle s'exécute.
- Un numéro de téléphone pouvant recevoir un SMS de vérification (pour le chemin d'enregistrement SMS).
- Accès navigateur pour le captcha Signal (`signalcaptchas.org`) pendant l'enregistrement.

## Configuration rapide (débutant)

1. Utilisez un **numéro Signal séparé** pour le bot (recommandé).
2. Installez `signal-cli` (Java requis si vous utilisez la version JVM).
3. Choisissez un chemin de configuration :
   - **Chemin A (QR link) :** `signal-cli link -n "OpenClaw"` et scannez avec Signal.
   - **Chemin B (enregistrement SMS) :** enregistrez un numéro dédié avec captcha + vérification SMS.
4. Configurez OpenClaw et redémarrez la passerelle.
5. Envoyez un premier DM et approuvez l'appairage (`openclaw pairing approve signal <CODE>`).

Config minimale :

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

Référence des champs :

| Champ       | Description                                                 |
| ----------- | ----------------------------------------------------------- |
| `account`   | Numéro de téléphone du bot au format E.164 (`+15551234567`) |
| `cliPath`   | Chemin vers `signal-cli` (`signal-cli` si dans `PATH`)      |
| `dmPolicy`  | Politique d'accès DM (`pairing` recommandé)                 |
| `allowFrom` | Numéros de téléphone ou valeurs `uuid:<id>` autorisés en DM |

## Ce que c'est

- Canal Signal via `signal-cli` (pas libsignal intégré).
- Routage déterministe : les réponses reviennent toujours à Signal.
- Les DM partagent la session principale de l'agent ; les groupes sont isolés (`agent:<agentId>:signal:group:<groupId>`).

## Écritures de config

Par défaut, Signal est autorisé à écrire des mises à jour de config déclenchées par `/config set|unset` (nécessite `commands.config: true`).

Désactiver avec :

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## Le modèle de numéro (important)

- La passerelle se connecte à un **appareil Signal** (le compte `signal-cli`).
- Si vous exécutez le bot sur **votre compte Signal personnel**, il ignorera vos propres messages (protection contre les boucles).
- Pour "j'envoie un texto au bot et il répond," utilisez un **numéro de bot séparé**.

## Chemin de configuration A : lier un compte Signal existant (QR)

1. Installez `signal-cli` (version JVM ou native).
2. Liez un compte bot :
   - `signal-cli link -n "OpenClaw"` puis scannez le QR dans Signal.
3. Configurez Signal et démarrez la passerelle.

Exemple :

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

Support multi-compte : utilisez `channels.signal.accounts` avec config par compte et `name` optionnel. Voir [`gateway/configuration`](/fr-FR/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) pour le modèle partagé.

## Chemin de configuration B : enregistrer un numéro de bot dédié (SMS, Linux)

Utilisez ceci quand vous voulez un numéro de bot dédié au lieu de lier un compte d'app Signal existant.

1. Obtenez un numéro pouvant recevoir des SMS (ou vérification vocale pour les lignes fixes).
   - Utilisez un numéro de bot dédié pour éviter les conflits de compte/session.
2. Installez `signal-cli` sur l'hôte de passerelle :

```bash
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
sudo tar xf "signal-cli-${VERSION}-Linux-native.tar.gz" -C /opt
sudo ln -sf /opt/signal-cli /usr/local/bin/
signal-cli --version
```

Si vous utilisez la version JVM (`signal-cli-${VERSION}.tar.gz`), installez d'abord JRE 25+.
Gardez `signal-cli` à jour ; upstream note que les anciennes versions peuvent casser à mesure que les API du serveur Signal changent.

3. Enregistrez et vérifiez le numéro :

```bash
signal-cli -a +<NUMÉRO_TÉLÉPHONE_BOT> register
```

Si le captcha est requis :

1. Ouvrez `https://signalcaptchas.org/registration/generate.html`.
2. Complétez le captcha, copiez la cible du lien `signalcaptcha://...` de "Open Signal".
3. Exécutez depuis la même IP externe que la session du navigateur quand possible.
4. Exécutez l'enregistrement à nouveau immédiatement (les tokens captcha expirent rapidement) :

```bash
signal-cli -a +<NUMÉRO_TÉLÉPHONE_BOT> register --captcha '<URL_SIGNALCAPTCHA>'
signal-cli -a +<NUMÉRO_TÉLÉPHONE_BOT> verify <CODE_VÉRIFICATION>
```

4. Configurez OpenClaw, redémarrez la passerelle, vérifiez le canal :

```bash
# Si vous exécutez la passerelle comme service systemd utilisateur :
systemctl --user restart openclaw-gateway

# Puis vérifiez :
openclaw doctor
openclaw channels status --probe
```

5. Appairez votre expéditeur DM :
   - Envoyez n'importe quel message au numéro du bot.
   - Approuvez le code sur le serveur : `openclaw pairing approve signal <CODE_APPAIRAGE>`.
   - Sauvegardez le numéro du bot comme contact sur votre téléphone pour éviter "Contact inconnu".

Important : enregistrer un compte de numéro de téléphone avec `signal-cli` peut dé-authentifier la session principale de l'app Signal pour ce numéro. Préférez un numéro de bot dédié, ou utilisez le mode QR link si vous devez garder votre configuration d'app téléphone existante.

Références upstream :

- README `signal-cli` : `https://github.com/AsamK/signal-cli`
- Flux captcha : `https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha`
- Flux de liaison : `https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)`

## Mode daemon externe (httpUrl)

Si vous voulez gérer `signal-cli` vous-même (démarrages à froid JVM lents, init conteneur, ou CPU partagés), exécutez le daemon séparément et pointez OpenClaw vers lui :

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

Ceci ignore le lancement automatique et l'attente de démarrage dans OpenClaw. Pour les démarrages lents lors du lancement automatique, définissez `channels.signal.startupTimeoutMs`.

## Contrôle d'accès (DM + groupes)

DM :

- Par défaut : `channels.signal.dmPolicy = "pairing"`.
- Les expéditeurs inconnus reçoivent un code d'appairage ; les messages sont ignorés jusqu'à approbation (les codes expirent après 1 heure).
- Approuver via :
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- L'appairage est l'échange de token par défaut pour les DM Signal. Détails : [Appairage](/fr-FR/channels/pairing)
- Les expéditeurs UUID uniquement (depuis `sourceUuid`) sont stockés comme `uuid:<id>` dans `channels.signal.allowFrom`.

Groupes :

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` contrôle qui peut déclencher dans les groupes quand `allowlist` est défini.

## Comment ça fonctionne (comportement)

- `signal-cli` s'exécute comme daemon ; la passerelle lit les événements via SSE.
- Les messages entrants sont normalisés dans l'enveloppe de canal partagée.
- Les réponses routent toujours vers le même numéro ou groupe.

## Média + limites

- Le texte sortant est découpé à `channels.signal.textChunkLimit` (par défaut 4000).
- Découpage de nouvelle ligne optionnel : définissez `channels.signal.chunkMode="newline"` pour diviser sur les lignes vides (limites de paragraphe) avant le découpage par longueur.
- Pièces jointes supportées (base64 récupéré depuis `signal-cli`).
- Plafond média par défaut : `channels.signal.mediaMaxMb` (par défaut 8).
- Utilisez `channels.signal.ignoreAttachments` pour ignorer le téléchargement des médias.
- Le contexte d'historique de groupe utilise `channels.signal.historyLimit` (ou `channels.signal.accounts.*.historyLimit`), se rabattant sur `messages.groupChat.historyLimit`. Définissez `0` pour désactiver (par défaut 50).

## Indicateurs de saisie + accusés de lecture

- **Indicateurs de saisie** : OpenClaw envoie des signaux de saisie via `signal-cli sendTyping` et les rafraîchit pendant qu'une réponse est en cours.
- **Accusés de lecture** : quand `channels.signal.sendReadReceipts` est true, OpenClaw transmet les accusés de lecture pour les DM autorisés.
- Signal-cli n'expose pas les accusés de lecture pour les groupes.

## Réactions (outil de message)

- Utilisez `message action=react` avec `channel=signal`.
- Cibles : E.164 ou UUID de l'expéditeur (utilisez `uuid:<id>` depuis la sortie d'appairage ; UUID nu fonctionne aussi).
- `messageId` est l'horodatage Signal pour le message auquel vous réagissez.
- Les réactions de groupe nécessitent `targetAuthor` ou `targetAuthorUuid`.

Exemples :

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Config :

- `channels.signal.actions.reactions` : activer/désactiver les actions de réaction (par défaut true).
- `channels.signal.reactionLevel` : `off | ack | minimal | extensive`.
  - `off`/`ack` désactive les réactions de l'agent (l'outil de message `react` renverra une erreur).
  - `minimal`/`extensive` active les réactions de l'agent et définit le niveau d'orientation.
- Remplacements par compte : `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## Cibles de livraison (CLI/cron)

- DM : `signal:+15551234567` (ou E.164 brut).
- UUID DM : `uuid:<id>` (ou UUID nu).
- Groupes : `signal:group:<groupId>`.
- Noms d'utilisateur : `username:<name>` (si supporté par votre compte Signal).

## Dépannage

Exécutez d'abord cette échelle :

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Puis confirmez l'état d'appairage DM si nécessaire :

```bash
openclaw pairing list signal
```

Échecs courants :

- Daemon accessible mais pas de réponses : vérifiez les paramètres de compte/daemon (`httpUrl`, `account`) et le mode de réception.
- DM ignorés : l'expéditeur est en attente d'approbation d'appairage.
- Messages de groupe ignorés : le portail expéditeur/mention de groupe bloque la livraison.
- Erreurs de validation de config après éditions : exécutez `openclaw doctor --fix`.
- Signal manquant dans les diagnostics : confirmez `channels.signal.enabled: true`.

Vérifications supplémentaires :

```bash
openclaw pairing list signal
pgrep -af signal-cli
grep -i "signal" "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | tail -20
```

Pour le flux de triage : [/channels/troubleshooting](/fr-FR/channels/troubleshooting).

## Notes de sécurité

- `signal-cli` stocke les clés de compte localement (typiquement `~/.local/share/signal-cli/data/`).
- Sauvegardez l'état du compte Signal avant une migration ou reconstruction du serveur.
- Gardez `channels.signal.dmPolicy: "pairing"` sauf si vous voulez explicitement un accès DM plus large.
- La vérification SMS est uniquement nécessaire pour les flux d'enregistrement ou de récupération, mais perdre le contrôle du numéro/compte peut compliquer le ré-enregistrement.

## Référence de configuration (Signal)

Configuration complète : [Configuration](/fr-FR/gateway/configuration)

Options du fournisseur :

- `channels.signal.enabled` : activer/désactiver le démarrage du canal.
- `channels.signal.account` : E.164 pour le compte du bot.
- `channels.signal.cliPath` : chemin vers `signal-cli`.
- `channels.signal.httpUrl` : URL daemon complète (remplace host/port).
- `channels.signal.httpHost`, `channels.signal.httpPort` : liaison daemon (par défaut 127.0.0.1:8080).
- `channels.signal.autoStart` : lancement automatique du daemon (par défaut true si `httpUrl` non défini).
- `channels.signal.startupTimeoutMs` : timeout d'attente de démarrage en ms (plafond 120000).
- `channels.signal.receiveMode` : `on-start | manual`.
- `channels.signal.ignoreAttachments` : ignorer les téléchargements de pièces jointes.
- `channels.signal.ignoreStories` : ignorer les stories du daemon.
- `channels.signal.sendReadReceipts` : transmettre les accusés de lecture.
- `channels.signal.dmPolicy` : `pairing | allowlist | open | disabled` (par défaut : pairing).
- `channels.signal.allowFrom` : liste blanche DM (E.164 ou `uuid:<id>`). `open` nécessite `"*"`. Signal n'a pas de noms d'utilisateur ; utilisez les id téléphone/UUID.
- `channels.signal.groupPolicy` : `open | allowlist | disabled` (par défaut : allowlist).
- `channels.signal.groupAllowFrom` : liste blanche d'expéditeur de groupe.
- `channels.signal.historyLimit` : max de messages de groupe à inclure comme contexte (0 désactive).
- `channels.signal.dmHistoryLimit` : limite d'historique DM en tours utilisateur. Remplacements par utilisateur : `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit` : taille de morceau sortant (caractères).
- `channels.signal.chunkMode` : `length` (par défaut) ou `newline` pour diviser sur les lignes vides (limites de paragraphe) avant le découpage par longueur.
- `channels.signal.mediaMaxMb` : plafond média entrant/sortant (Mo).

Options globales connexes :

- `agents.list[].groupChat.mentionPatterns` (Signal ne supporte pas les mentions natives).
- `messages.groupChat.mentionPatterns` (solution de secours globale).
- `messages.responsePrefix`.
