---
summary: "Persistance permissions macOS (TCC) et exigences signature"
read_when:
  - Débogage prompts permission macOS manquants ou bloqués
  - Packaging ou signature app macOS
  - Changement IDs bundle ou chemins installation app
title: "Permissions macOS"
---

# Permissions macOS (TCC)

Les accords permission macOS sont fragiles. TCC associe un accord permission avec la signature code app, l'identifiant bundle et le chemin sur disque. Si l'un de ceux-ci change, macOS traite l'app comme nouvelle et peut drop ou cacher les prompts.

## Exigences pour permissions stables

- Même chemin : exécutez l'app depuis un emplacement fixe (pour OpenClaw, `dist/OpenClaw.app`).
- Même identifiant bundle : changer l'ID bundle crée une nouvelle identité permission.
- App signée : les builds non signés ou ad-hoc signés ne persistent pas les permissions.
- Signature cohérente : utilisez un vrai certificat Apple Development ou Developer ID donc la signature reste stable à travers les rebuilds.

Les signatures ad-hoc génèrent une nouvelle identité à chaque build. macOS oubliera les accords précédents, et les prompts peuvent disparaître entièrement jusqu'à ce que les entrées périmées soient effacées.

## Checklist récupération quand prompts disparaissent

1. Quittez l'app.
2. Supprimez l'entrée app dans Réglages Système -> Confidentialité & Sécurité.
3. Relancez l'app depuis le même chemin et ré-accordez les permissions.
4. Si le prompt n'apparaît toujours pas, réinitialisez les entrées TCC avec `tccutil` et réessayez.
5. Certaines permissions réapparaissent uniquement après redémarrage complet macOS.

Exemples réinitialisations (remplacez ID bundle selon besoin) :

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Permissions fichiers et dossiers (Desktop/Documents/Downloads)

macOS peut aussi gater Desktop, Documents et Downloads pour processus terminal/background. Si les lectures fichier ou listages répertoire se bloquent, accordez accès au même contexte processus qui effectue opérations fichier (par exemple Terminal/iTerm, app lancée LaunchAgent ou processus SSH).

Contournement : déplacez les fichiers dans le workspace OpenClaw (`~/.openclaw/workspace`) si vous voulez éviter les accords per-folder.

Si vous testez les permissions, signez toujours avec un vrai certificat. Les builds ad-hoc sont uniquement acceptables pour exécutions locales rapides où les permissions n'importent pas.

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Passerelle Bundled](/fr-FR/platforms/mac/bundled-gateway)
- [Configuration](/fr-FR/gateway/configuration)
