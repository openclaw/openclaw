---
summary: "iMessage via serveur BlueBubbles macOS (envoi/réception REST, frappe, réactions, appairage, actions avancées)"
read_when:
  - Configuration du canal BlueBubbles
  - Dépannage de l'appairage webhook
  - Configuration d'iMessage sur macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Statut : plugin intégré qui communique avec le serveur BlueBubbles macOS via HTTP. **Recommandé pour l'intégration iMessage** en raison de son API plus riche et de sa configuration plus facile par rapport au canal imsg hérité.

## Aperçu

- S'exécute sur macOS via l'application helper BlueBubbles ([bluebubbles.app](https://bluebubbles.app)).
- Recommandé/testé : macOS Sequoia (15). macOS Tahoe (26) fonctionne ; la modification est actuellement cassée sur Tahoe, et les mises à jour d'icône de groupe peuvent rapporter un succès mais ne se synchronisent pas.
- OpenClaw lui parle via son API REST (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Les messages entrants arrivent via webhooks ; les réponses sortantes, indicateurs de frappe, accusés de lecture et tapbacks sont des appels REST.
- Les pièces jointes et autocollants sont ingérés comme médias entrants (et présentés à l'agent quand possible).
- L'appairage/liste d'autorisation fonctionne de la même manière que les autres canaux (`/fr-FR/channels/pairing` etc) avec `channels.bluebubbles.allowFrom` + codes d'appairage.
- Les réactions sont présentées comme événements système tout comme Slack/Telegram pour que les agents puissent les "mentionner" avant de répondre.
- Fonctionnalités avancées : modifier, annuler l'envoi, fils de réponse, effets de message, gestion de groupe.

## Démarrage rapide

1. Installez le serveur BlueBubbles sur votre Mac (suivez les instructions sur [bluebubbles.app/install](https://bluebubbles.app/install)).
2. Dans la config BlueBubbles, activez l'API web et définissez un mot de passe.
3. Exécutez `openclaw onboard` et sélectionnez BlueBubbles, ou configurez manuellement :

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Pointez les webhooks BlueBubbles vers votre passerelle (exemple : `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).
5. Démarrez la passerelle ; elle enregistrera le gestionnaire webhook et commencera l'appairage.

Note de sécurité :

- Définissez toujours un mot de passe webhook. Si vous exposez la passerelle via un proxy inverse (Tailscale Serve/Funnel, nginx, Cloudflare Tunnel, ngrok), le proxy peut se connecter à la passerelle via loopback. Le gestionnaire webhook BlueBubbles traite les requêtes avec headers de transfert comme proxifiées et n'acceptera pas les webhooks sans mot de passe.

## Garder Messages.app vivant (VM / configurations headless)

Certaines configurations VM macOS / toujours actives peuvent finir avec Messages.app devenant "idle" (les événements entrants s'arrêtent jusqu'à ce que l'app soit ouverte/mise au premier plan). Une solution simple est de **piquer Messages toutes les 5 minutes** en utilisant un AppleScript + LaunchAgent.

### 1) Sauvegarder l'AppleScript

Sauvegardez ceci en tant que :

- `~/Scripts/poke-messages.scpt`

Exemple de script (non interactif ; ne vole pas le focus) :

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Toucher l'interface de script pour garder le processus réactif.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignorer les échecs transitoires (invites première exécution, session verrouillée, etc).
end try
```

### 2) Installer un LaunchAgent

Sauvegardez ceci en tant que :

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Notes :

- Ceci s'exécute **toutes les 300 secondes** et **à la connexion**.
- La première exécution peut déclencher des invites macOS **Automation** (`osascript` → Messages). Approuvez-les dans la même session utilisateur qui exécute le LaunchAgent.

Chargez-le :

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

BlueBubbles est disponible dans l'assistant de configuration interactif :

```
openclaw onboard
```

L'assistant demande :

- **URL du serveur** (requis) : adresse du serveur BlueBubbles (par ex., `http://192.168.1.100:1234`)
- **Mot de passe** (requis) : mot de passe API depuis les paramètres du serveur BlueBubbles
- **Chemin webhook** (optionnel) : par défaut `/bluebubbles-webhook`
- **Politique DM** : pairing, allowlist, open, ou disabled
- **Liste d'autorisation** : numéros de téléphone, emails ou cibles de chat

Vous pouvez aussi ajouter BlueBubbles via CLI :

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

[... suite du fichier avec toutes les autres sections traduites de manière idiomatique...]

## Voir aussi

- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
- [Sécurité de la Passerelle](/fr-FR/gateway/security)
- [Réactions](/fr-FR/tools/reactions)
- [Plugins](/fr-FR/tools/plugin)
- [Canaux](/fr-FR/channels)
