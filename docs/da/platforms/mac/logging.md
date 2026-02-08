---
summary: "OpenClaw-logning: rullende diagnostikfillog + privatlivsflag i unified logging"
read_when:
  - Indsamling af macOS-logs eller undersøgelse af logning af private data
  - Fejlfinding af problemer med voice wake/session-livscyklus
title: "macOS-logning"
x-i18n:
  source_path: platforms/mac/logging.md
  source_hash: c4c201d154915e0e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:24Z
---

# Logning (macOS)

## Rullende diagnostikfillog (Debug-pane)

OpenClaw ruter macOS-app-logs gennem swift-log (unified logging som standard) og kan skrive en lokal, roterende fillog til disk, når du har brug for en vedvarende optagelse.

- Detaljeniveau: **Debug-pane → Logs → App logging → Verbosity**
- Aktivér: **Debug-pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- Placering: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (roterer automatisk; gamle filer får suffiks `.1`, `.2`, …)
- Ryd: **Debug-pane → Logs → App logging → “Clear”**

Noter:

- Dette er **slået fra som standard**. Aktivér kun, mens du aktivt fejlsøger.
- Behandl filen som følsom; del den ikke uden gennemgang.

## Private data i unified logging på macOS

Unified logging redigerer de fleste payloads, medmindre et subsystem tilvælger `privacy -off`. Ifølge Peters gennemgang af macOS’ [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) styres dette af en plist i `/Library/Preferences/Logging/Subsystems/`, nøglelagt efter subsystem-navnet. Kun nye logposter får flaget, så aktivér det, før du genskaber et problem.

## Aktivér for OpenClaw (`bot.molt`)

- Skriv først plist-filen til en midlertidig fil, og installér den derefter atomisk som root:

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

- Ingen genstart er nødvendig; logd registrerer filen hurtigt, men kun nye loglinjer vil inkludere private payloads.
- Se det mere detaljerede output med den eksisterende hjælper, f.eks. `./scripts/clawlog.sh --category WebChat --last 5m`.

## Deaktivér efter fejlfinding

- Fjern overstyringen: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- Kør eventuelt `sudo log config --reload` for at tvinge logd til at fjerne overstyringen med det samme.
- Husk, at denne flade kan indeholde telefonnumre og beskedindhold; behold kun plist-filen på plads, mens du aktivt har brug for de ekstra detaljer.
