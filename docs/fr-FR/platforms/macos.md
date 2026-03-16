---
summary: "App compagnon macOS OpenClaw (menu bar + broker passerelle)"
read_when:
  - Implémentation fonctionnalités app macOS
  - Changement lifecycle passerelle ou bridging nœud sur macOS
title: "App macOS"
---

# Compagnon macOS OpenClaw (menu bar + broker passerelle)

L'app macOS est le **compagnon menu-bar** pour OpenClaw. Elle possède permissions, gère/s'attache à la Passerelle localement (launchd ou manuel) et expose capacités macOS à l'agent comme nœud.

## Ce qu'elle fait

- Montre notifications natives et statut dans menu bar.
- Possède prompts TCC (Notifications, Accessibility, Screen Recording, Microphone, Speech Recognition, Automation/AppleScript).
- Exécute ou se connecte à la Passerelle (local ou remote).
- Expose outils macOS-only (Canvas, Camera, Screen Recording, `system.run`).
- Démarre service hôte nœud local en mode **remote** (launchd) et l'arrête en mode **local**.
- Héberge optionnellement **PeekabooBridge** pour automation UI.
- Installe le CLI global (`openclaw`) via npm/pnpm sur demande (bun non recommandé pour runtime Passerelle).

## Mode Local vs Remote

- **Local** (défaut) : l'app s'attache à Passerelle locale en cours si présente ; sinon active service launchd via `openclaw gateway install`.
- **Remote** : l'app se connecte à Passerelle via SSH/Tailscale et ne démarre jamais processus local. L'app démarre **service hôte nœud local** donc Passerelle remote peut atteindre ce Mac. L'app ne spawn pas la Passerelle comme processus enfant.

## Contrôle Launchd

L'app gère LaunchAgent per-user labellisé `bot.molt.gateway` (ou `bot.molt.<profile>` en utilisant `--profile`/`OPENCLAW_PROFILE` ; legacy `com.openclaw.*` unload toujours).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Remplacez label avec `bot.molt.<profile>` lors exécution profil nommé.

Si LaunchAgent n'est pas installé, activez-le depuis l'app ou exécutez `openclaw gateway install`.

## Capacités Nœud (mac)

L'app macOS se présente comme nœud. Commandes courantes :

- Canvas : `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera : `camera.snap`, `camera.clip`
- Screen : `screen.record`
- System : `system.run`, `system.notify`

Le nœud rapporte map `permissions` donc agents peuvent décider ce qui est autorisé.

## Approvals Exec (system.run)

`system.run` est contrôlé par **Exec approvals** dans l'app macOS (Réglages → Exec approvals). Sécurité + ask + allowlist sont stockés localement sur Mac.

Voir aussi :

- [Passerelle Bundled](/fr-FR/platforms/mac/bundled-gateway)
- [Permissions macOS](/fr-FR/platforms/mac/permissions)
- [Canvas](/fr-FR/platforms/mac/canvas)
- [Configuration](/fr-FR/gateway/configuration)
