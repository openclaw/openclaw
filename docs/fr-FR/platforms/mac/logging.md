---
summary: "Logging OpenClaw : log fichier diagnostics rolling + flags privacité unified log"
read_when:
  - Capture logs macOS ou investigation logging données privées
  - Débogage voice wake/issues lifecycle session
title: "Logging macOS"
---

# Logging (macOS)

## Log fichier diagnostics rolling (panneau Debug)

OpenClaw route logs app macOS à travers swift-log (unified logging par défaut) et peut écrire log fichier local, rotatif sur disque quand vous avez besoin capture durable.

- Verbosité : **Panneau Debug → Logs → App logging → Verbosity**
- Activer : **Panneau Debug → Logs → App logging → "Write rolling diagnostics log (JSONL)"**
- Emplacement : `~/Library/Logs/OpenClaw/diagnostics.jsonl` (rotate automatiquement ; vieux fichiers suffixés `.1`, `.2`, …)
- Effacer : **Panneau Debug → Logs → App logging → "Clear"**

Notes :

- C'est **désactivé par défaut**. Activez uniquement en déboguant activement.
- Traitez fichier comme sensible ; ne le partagez pas sans révision.

## Données privées unified logging sur macOS

Unified logging redacte la plupart payloads sauf si subsystem opte vers `privacy -off`. Par write-up Peter sur macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) c'est contrôlé par plist dans `/Library/Preferences/Logging/Subsystems/` keyed par nom subsystem. Seules nouvelles entrées log prennent flag, donc activez avant reproduire issue.

## Activer pour OpenClaw (`bot.molt`)

Écrivez plist vers fichier temp d'abord, puis installez-le atomiquement comme root :

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

Pas de reboot requis ; logd remarque fichier rapidement, mais seules nouvelles lignes log incluront payloads privés.

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Dépannage](/fr-FR/gateway/troubleshooting)
- [Configuration](/fr-FR/gateway/configuration)
