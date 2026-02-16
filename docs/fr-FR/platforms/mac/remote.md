---
summary: "Flux app macOS pour contrôler passerelle OpenClaw distante via SSH"
read_when:
  - Configuration ou débogage contrôle mac distant
title: "Contrôle Distant"
---

# OpenClaw Distant (macOS ⇄ host distant)

Ce flux permet app macOS d'agir comme contrôle distant complet pour passerelle OpenClaw tournant sur autre host (desktop/serveur). C'est fonctionnalité **Remote over SSH** (run distant) de l'app. Toutes fonctionnalités—health checks, forwarding Voice Wake et Web Chat—réutilisent même configuration SSH distante depuis _Paramètres → Général_.

## Modes

- **Local (this Mac)** : Tout tourne sur laptop. Aucun SSH impliqué.
- **Remote over SSH (défaut)** : Commandes OpenClaw exécutées sur host distant. App mac ouvre connexion SSH avec `-o BatchMode` plus votre identity/key choisie et port-forward local.
- **Remote direct (ws/wss)** : Aucun tunnel SSH. App mac se connecte directement à URL passerelle (par exemple, via Tailscale Serve ou reverse proxy HTTPS public).

## Transports distants

Mode distant supporte deux transports :

- **Tunnel SSH** (défaut) : Utilise `ssh -N -L ...` pour forwarder port passerelle vers localhost. Passerelle verra IP node comme `127.0.0.1` car tunnel est loopback.
- **Direct (ws/wss)** : Se connecte directement à URL passerelle. Passerelle voit vraie IP client.

## Prérequis sur host distant

1. Installez Node + pnpm et build/installez CLI OpenClaw (`pnpm install && pnpm build && pnpm link --global`).
2. Assurez `openclaw` sur PATH pour shells non-interactifs (symlink dans `/usr/local/bin` ou `/opt/homebrew/bin` si nécessaire).
3. Ouvrez SSH avec auth key. Nous recommandons IPs **Tailscale** pour accessibilité stable hors-LAN.

## Setup app macOS

1. Ouvrez _Paramètres → Général_.
2. Sous **OpenClaw runs**, choisissez **Remote over SSH** et définissez :
   - **Transport** : **SSH tunnel** ou **Direct (ws/wss)**.
   - **SSH target** : `user@host` (`:port` optionnel).
     - Si passerelle sur même LAN et advertise Bonjour, choisissez depuis liste découverte pour auto-remplir ce champ.
   - **URL Passerelle** (Direct seulement) : `wss://gateway.example.ts.net` (ou `ws://...` pour local/LAN).
   - **Identity file** (avancé) : chemin vers votre key.
   - **Project root** (avancé) : chemin checkout distant utilisé pour commandes.
   - **CLI path** (avancé) : chemin optionnel vers entrypoint/binaire `openclaw` exécutable (auto-rempli quand advertised).
3. Cliquez **Test remote**. Succès indique `openclaw status --json` distant tourne correctement. Échecs signifient généralement problèmes PATH/CLI ; exit 127 signifie CLI introuvable à distance.
4. Health checks et Web Chat tourneront désormais via ce tunnel SSH automatiquement.

## Web Chat

- **Tunnel SSH** : Web Chat se connecte à passerelle via port contrôle WebSocket forwardé (défaut 18789).
- **Direct (ws/wss)** : Web Chat se connecte directement à URL passerelle configurée.
- Plus de serveur HTTP WebChat séparé.

## Permissions

- Host distant nécessite mêmes approbations TCC que local (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). Exécutez onboarding sur cette machine pour les accorder une fois.
- Nodes advertise leur état permissions via `node.list` / `node.describe` donc agents savent ce qui est disponible.

## Notes sécurité

- Préférez binds loopback sur host distant et connectez via SSH ou Tailscale.
- Si vous bindez Passerelle sur interface non-loopback, requérez auth token/password.
- Voir [Sécurité](/fr-FR/gateway/security) et [Tailscale](/fr-FR/gateway/tailscale).

## Flux login WhatsApp (distant)

- Exécutez `openclaw channels login --verbose` **sur host distant**. Scannez QR avec WhatsApp sur téléphone.
- Relancez login sur ce host si auth expire. Health check surfacera problèmes link.

## Dépannage

- **exit 127 / not found** : `openclaw` n'est pas sur PATH pour shells non-login. Ajoutez-le à `/etc/paths`, votre shell rc, ou symlink dans `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe échoué** : vérifiez accessibilité SSH, PATH et que Baileys est logged in (`openclaw status --json`).
- **Web Chat bloqué** : confirmez passerelle tourne sur host distant et port forwardé correspond port WS passerelle ; UI requiert connexion WS saine.
- **IP Node affiche 127.0.0.1** : attendu avec tunnel SSH. Switchez **Transport** vers **Direct (ws/wss)** si vous voulez que passerelle voie vraie IP client.
- **Voice Wake** : phrases déclencheur forwardées automatiquement en mode distant ; aucun forwarder séparé nécessaire.

## Sons notification

Choisissez sons per notification depuis scripts avec `openclaw` et `node.invoke`, ex :

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Passerelle distante prête" --sound Glass
```

Plus de toggle global "default sound" dans app ; callers choisissent son (ou aucun) per requête.

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Configuration](/fr-FR/gateway/configuration)
- [Sécurité](/fr-FR/gateway/security)
