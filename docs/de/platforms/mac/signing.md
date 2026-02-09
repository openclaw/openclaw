---
summary: "Signierschritte für macOS-Debug-Builds, die von Packaging-Skripten erzeugt werden"
read_when:
  - Beim Erstellen oder Signieren von macOS-Debug-Builds
title: "macOS-Signierung"
---

# mac-Signierung (Debug-Builds)

Diese App wird üblicherweise aus [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) erstellt, das jetzt:

- eine stabile Debug-Bundle-ID setzt: `ai.openclaw.mac.debug`
- die Info.plist mit dieser Bundle-ID schreibt (Überschreiben über `BUNDLE_ID=...`)
- [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) aufruft, um das Haupt-Binary und das App-Bundle zu signieren, sodass macOS jeden Neuaufbau als dasselbe signierte Bundle behandelt und TCC-Berechtigungen (Benachrichtigungen, Bedienungshilfen, Bildschirmaufzeichnung, Mikrofon, Sprache) beibehält. Für stabile Berechtigungen verwenden Sie eine echte Signieridentität; Ad-hoc ist optional und fragil (siehe [macOS-Berechtigungen](/platforms/mac/permissions)).
- standardmäßig `CODESIGN_TIMESTAMP=auto` verwendet; dies aktiviert vertrauenswürdige Zeitstempel für Developer-ID-Signaturen. Setzen Sie `CODESIGN_TIMESTAMP=off`, um die Zeitstempelung zu überspringen (Offline-Debug-Builds).
- Build-Metadaten in die Info.plist injiziert: `OpenClawBuildTimestamp` (UTC) und `OpenClawGitCommit` (kurzer Hash), damit der „Über“-Bereich Build-, Git- sowie Debug/Release-Kanal anzeigen kann.
- **Packaging erfordert Node 22+**: Das Skript führt TS-Builds und den Control-UI-Build aus.
- `SIGN_IDENTITY` aus der Umgebung liest. Fügen Sie `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (oder Ihr Developer ID Application-Zertifikat) Ihrer Shell-RC hinzu, um immer mit Ihrem Zertifikat zu signieren. Ad-hoc-Signierung erfordert ein explizites Opt-in über `ALLOW_ADHOC_SIGNING=1` oder `SIGN_IDENTITY="-"` (nicht empfohlen für Berechtigungstests).
- nach der Signierung eine Team-ID-Prüfung ausführt und fehlschlägt, wenn irgendein Mach-O innerhalb des App-Bundles von einer anderen Team-ID signiert ist. Setzen Sie `SKIP_TEAM_ID_CHECK=1`, um dies zu umgehen.

## Verwendung

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Hinweis zur Ad-hoc-Signierung

Beim Signieren mit `SIGN_IDENTITY="-"` (Ad-hoc) deaktiviert das Skript automatisch die **Hardened Runtime** (`--options runtime`). Dies ist erforderlich, um Abstürze zu verhindern, wenn die App versucht, eingebettete Frameworks (wie Sparkle) zu laden, die nicht dieselbe Team-ID teilen. Ad-hoc-Signaturen unterbrechen außerdem die Persistenz von TCC-Berechtigungen; siehe [macOS-Berechtigungen](/platforms/mac/permissions) für Wiederherstellungsschritte.

## Build-Metadaten für „Über“

`package-mac-app.sh` versieht das Bundle mit:

- `OpenClawBuildTimestamp`: ISO8601 UTC zum Packaging-Zeitpunkt
- `OpenClawGitCommit`: kurzer Git-Hash (oder `unknown`, falls nicht verfügbar)

Der „Über“-Tab liest diese Schlüssel, um Version, Build-Datum, Git-Commit und anzuzeigen, ob es sich um einen Debug-Build handelt (über `#if DEBUG`). Führen Sie den Packager aus, um diese Werte nach Code-Änderungen zu aktualisieren.

## Warum

TCC-Berechtigungen sind an die Bundle-ID _und_ die Code-Signatur gebunden. Unsigned Debug-Builds mit wechselnden UUIDs führten dazu, dass macOS die Freigaben nach jedem Neuaufbau vergaß. Das Signieren der Binaries (standardmäßig Ad-hoc) und das Beibehalten einer festen Bundle-ID/-Pfads (`dist/OpenClaw.app`) bewahrt die Freigaben zwischen Builds und entspricht dem VibeTunnel-Ansatz.
