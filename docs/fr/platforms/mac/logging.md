---
summary: "Journalisation OpenClaw : fichier de diagnostics à rotation + indicateurs de confidentialité de la journalisation unifiée"
read_when:
  - Capture des journaux macOS ou enquête sur la journalisation de données privées
  - Débogage des problèmes de cycle de vie de l’activation vocale/de session
title: "Journalisation macOS"
---

# Journalisation (macOS)

## Fichier de diagnostics à rotation (volet Debug)

OpenClaw achemine les journaux de l’app macOS via swift-log (journalisation unifiée par défaut) et peut écrire un fichier journal local à rotation sur le disque lorsque vous avez besoin d’une capture durable.

- Verbeuxité : **Debug pane → Logs → App logging → Verbosity**
- Activer : **Debug pane → Logs → App logging → « Write rolling diagnostics log (JSONL) »**
- Emplacement : `~/Library/Logs/OpenClaw/diagnostics.jsonl` (rotation automatique ; les anciens fichiers sont suffixés `.1`, `.2`, …)
- Effacer : **Debug pane → Logs → App logging → « Clear »**

Remarques :

- Cette option est **désactivée par défaut**. Activez-la uniquement pendant un débogage actif.
- Traitez le fichier comme sensible ; ne le partagez pas sans relecture.

## Données privées de la journalisation unifiée sur macOS

La journalisation unifiée expurge la plupart des charges utiles à moins qu’un sous-système n’opte pour `privacy -off`. Selon l’article de Peter sur macOS, [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025), ce comportement est contrôlé par un plist dans `/Library/Preferences/Logging/Subsystems/` indexé par le nom du sous-système. Seules les nouvelles entrées de journal prennent en compte l’indicateur ; activez-le donc avant de reproduire un problème.

## Activer pour OpenClaw (`bot.molt`)

- Écrivez d’abord le plist dans un fichier temporaire, puis installez-le de manière atomique en tant que root :

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

- Aucun redémarrage n’est requis ; logd détecte rapidement le fichier, mais seules les nouvelles lignes de journal incluront les charges utiles privées.
- Affichez la sortie enrichie avec l’outil d’assistance existant, par exemple `./scripts/clawlog.sh --category WebChat --last 5m`.

## Désactiver après le débogage

- Supprimez la surcharge : `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- Exécutez éventuellement `sudo log config --reload` pour forcer logd à abandonner immédiatement la surcharge.
- N’oubliez pas que cette surface peut inclure des numéros de téléphone et des corps de messages ; conservez le plist en place uniquement tant que vous avez activement besoin du niveau de détail supplémentaire.
