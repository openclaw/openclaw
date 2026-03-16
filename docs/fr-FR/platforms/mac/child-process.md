---
summary: "Lifecycle Passerelle sur macOS (launchd)"
read_when:
  - Intégration app mac avec lifecycle passerelle
title: "Lifecycle Passerelle"
---

# Lifecycle Passerelle sur macOS

App macOS **gère Passerelle via launchd** par défaut et ne spawn pas Passerelle comme processus enfant. Elle essaie d'abord s'attacher à Passerelle déjà en cours sur port configuré ; si aucune accessible, elle active service launchd via CLI `openclaw` externe (aucun runtime embarqué). Cela donne auto-start fiable au login et restart sur crashes.

Mode child-process (Passerelle spawnée directement par app) n'est **pas utilisé** aujourd'hui. Si vous avez besoin couplage plus serré avec UI, exécutez Passerelle manuellement dans terminal.

## Comportement défaut (launchd)

- App installe LaunchAgent per-user labelisé `bot.molt.gateway`
  (ou `bot.molt.<profile>` lors utilisation `--profile`/`OPENCLAW_PROFILE` ; legacy `com.openclaw.*` supporté).
- Quand mode Local activé, app assure LaunchAgent chargé et démarre Passerelle si nécessaire.
- Logs écrits vers chemin log passerelle launchd (visible dans Debug Settings).

Commandes communes :

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Remplacez label par `bot.molt.<profile>` lors exécution profil nommé.

## Builds dev non signés

`scripts/restart-mac.sh --no-sign` pour builds locaux rapides quand vous n'avez pas clés signing. Pour empêcher launchd pointer vers binaire relay non signé, il :

- Écrit `~/.openclaw/disable-launchagent`.

Runs signés de `scripts/restart-mac.sh` clearent cet override si marker présent. Pour reset manuellement :

```bash
rm ~/.openclaw/disable-launchagent
```

## Mode attach-only

Pour forcer app macOS à **jamais installer ou gérer launchd**, lancez-la avec `--attach-only` (ou `--no-launchd`). Ceci définit `~/.openclaw/disable-launchagent`, donc app s'attache seulement à Passerelle déjà en cours. Vous pouvez toggler même comportement dans Debug Settings.

## Mode distant

Mode distant ne démarre jamais Passerelle locale. App utilise tunnel SSH vers host distant et se connecte via ce tunnel.

## Pourquoi nous préférons launchd

- Auto-start au login.
- Sémantiques restart/KeepAlive intégrées.
- Logs et supervision prévisibles.

Si vrai mode child-process jamais nécessaire à nouveau, devrait être documenté comme mode séparé, explicite dev-only.

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Contrôle Distant](/fr-FR/platforms/mac/remote)
- [Configuration](/fr-FR/gateway/configuration)
