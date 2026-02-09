---
summary: "Logowanie OpenClaw: rotujący plik diagnostyczny + flagi prywatności unified logging"
read_when:
  - Przechwytywanie logów macOS lub badanie logowania danych prywatnych
  - Debugowanie problemów z wybudzaniem głosowym i cyklem życia sesji
title: "Logowanie macOS"
---

# Logowanie (macOS)

## Rotujący plik diagnostyczny (panel Debug)

OpenClaw kieruje logi aplikacji macOS przez swift-log (domyślnie unified logging) i może zapisywać lokalny, rotujący plik logów na dysku, gdy potrzebne jest trwałe przechwytywanie.

- Poziom szczegółowości: **Debug pane → Logs → App logging → Verbosity**
- Włącz: **Debug pane → Logs → App logging → „Write rolling diagnostics log (JSONL)”**
- Lokalizacja: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (rotuje automatycznie; starsze pliki otrzymują sufiksy `.1`, `.2`, …)
- Wyczyść: **Debug pane → Logs → App logging → „Clear”**

Uwagi:

- Ta opcja jest **domyślnie wyłączona**. Włączaj ją tylko podczas aktywnego debugowania.
- Traktuj plik jako wrażliwy; nie udostępniaj go bez przeglądu.

## Prywatne dane w unified logging na macOS

Unified logging redaguje większość ładunków, chyba że podsystem wyrazi zgodę na `privacy -off`. Zgodnie z opisem Petera na temat macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) jest to kontrolowane przez plist w `/Library/Preferences/Logging/Subsystems/`, kluczowany nazwą podsystemu. Tylko nowe wpisy logów przejmują tę flagę, więc włącz ją przed odtworzeniem problemu.

## Włącz dla OpenClaw (`bot.molt`)

- Najpierw zapisz plist do pliku tymczasowego, a następnie zainstaluj go atomowo jako root:

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

- Restart nie jest wymagany; logd szybko wykrywa plik, ale tylko nowe linie logów będą zawierać prywatne ładunki.
- Bogatsze wyjście wyświetlisz za pomocą istniejącego narzędzia pomocniczego, np. `./scripts/clawlog.sh --category WebChat --last 5m`.

## Wyłącz po debugowaniu

- Usuń nadpisanie: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- Opcjonalnie uruchom `sudo log config --reload`, aby wymusić natychmiastowe usunięcie nadpisania przez logd.
- Pamiętaj, że ta powierzchnia może zawierać numery telefonów i treści wiadomości; pozostawiaj plist tylko tak długo, jak aktywnie potrzebujesz dodatkowych szczegółów.
