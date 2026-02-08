---
summary: "OpenClaw-loggning: rullande diagnostikfillogg + integritetsflaggor för unified log"
read_when:
  - Insamling av macOS-loggar eller undersökning av loggning av privata data
  - Felsökning av problem med röstväckning/sessionens livscykel
title: "macOS-loggning"
x-i18n:
  source_path: platforms/mac/logging.md
  source_hash: c4c201d154915e0e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:56Z
---

# Loggning (macOS)

## Rullande diagnostikfillogg (Debug-pane)

OpenClaw dirigerar macOS-apploggar via swift-log (unified logging som standard) och kan skriva en lokal, roterande fillogg till disk när du behöver en varaktig logginsamling.

- Verbositet: **Debug-pane → Logs → App logging → Verbosity**
- Aktivera: **Debug-pane → Logs → App logging → ”Write rolling diagnostics log (JSONL)”**
- Plats: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (roterar automatiskt; gamla filer får suffixen `.1`, `.2`, …)
- Rensa: **Debug-pane → Logs → App logging → ”Clear”**

Noteringar:

- Detta är **avstängt som standard**. Aktivera endast under aktiv felsökning.
- Behandla filen som känslig; dela den inte utan granskning.

## Unified logging: privata data på macOS

Unified logging maskerar de flesta nyttolaster om inte ett subsystem väljer `privacy -off`. Enligt Peters genomgång av macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) styrs detta av en plist i `/Library/Preferences/Logging/Subsystems/` som är nycklad efter subsystemets namn. Endast nya loggposter tar upp flaggan, så aktivera den innan du reproducerar ett problem.

## Aktivera för OpenClaw (`bot.molt`)

- Skriv plist-filen till en temporär fil först och installera den sedan atomiskt som root:

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

- Ingen omstart krävs; logd upptäcker filen snabbt, men endast nya loggrader kommer att inkludera privata nyttolaster.
- Visa den mer detaljerade utdata med den befintliga hjälparen, t.ex. `./scripts/clawlog.sh --category WebChat --last 5m`.

## Inaktivera efter felsökning

- Ta bort åsidosättningen: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- Kör eventuellt `sudo log config --reload` för att tvinga logd att omedelbart släppa åsidosättningen.
- Kom ihåg att denna yta kan innehålla telefonnummer och meddelandetexter; behåll plist-filen endast så länge du aktivt behöver den extra detaljnivån.
