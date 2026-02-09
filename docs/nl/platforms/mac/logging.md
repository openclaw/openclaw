---
summary: "OpenClaw-logging: roterend diagnostisch bestandslog + privacyvlaggen voor unified logging"
read_when:
  - Vastleggen van macOS-logs of onderzoek naar het loggen van privégegevens
  - Debuggen van problemen met de levenscyclus van voice wake/sessies
title: "macOS-logging"
---

# Logging (macOS)

## Roterend diagnostisch bestandslog (Debug-paneel)

OpenClaw leidt macOS-app-logs via swift-log (standaard unified logging) en kan een lokaal, roterend bestandslog naar schijf schrijven wanneer je een duurzame vastlegging nodig hebt.

- Uitgebreidheid: **Debug-paneel → Logs → App-logging → Uitgebreidheid**
- Inschakelen: **Debug-paneel → Logs → App-logging → “Roterend diagnostisch log schrijven (JSONL)”**
- Locatie: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (roteert automatisch; oude bestanden krijgen het achtervoegsel `.1`, `.2`, …)
- Wissen: **Debug-paneel → Logs → App-logging → “Wissen”**

Notities:

- Dit staat **standaard uit**. Schakel het alleen in tijdens actief debuggen.
- Behandel het bestand als gevoelig; deel het niet zonder controle.

## Private gegevens in unified logging op macOS

Unified logging redigeert de meeste payloads, tenzij een subsysteem zich aanmeldt voor `privacy -off`. Volgens Peter’s uiteenzetting over macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) wordt dit geregeld via een plist in `/Library/Preferences/Logging/Subsystems/` die is gesleuteld op de naam van het subsysteem. Alleen nieuwe logregels nemen de vlag over, dus schakel dit in vóórdat je een probleem reproduceert.

## Inschakelen voor OpenClaw (`bot.molt`)

- Schrijf de plist eerst naar een tijdelijk bestand en installeer deze daarna atomair als root:

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

- Er is geen herstart nodig; logd merkt het bestand snel op, maar alleen nieuwe logregels bevatten private payloads.
- Bekijk de rijkere uitvoer met de bestaande helper, bijvoorbeeld `./scripts/clawlog.sh --category WebChat --last 5m`.

## Uitschakelen na het debuggen

- Verwijder de override: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- Voer optioneel `sudo log config --reload` uit om logd te dwingen de override onmiddellijk te laten vallen.
- Onthoud dat dit oppervlak telefoonnummers en berichtinhoud kan bevatten; laat de plist alleen staan zolang je de extra details actief nodig hebt.
