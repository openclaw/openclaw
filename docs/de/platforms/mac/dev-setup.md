---
summary: "„Einrichtungsleitfaden für Entwickler, die an der OpenClaw macOS-App arbeiten“"
read_when:
  - Einrichten der macOS-Entwicklungsumgebung
title: "„macOS-Entwickler-Setup“"
---

# macOS-Entwickler-Setup

Dieser Leitfaden beschreibt die notwendigen Schritte, um die OpenClaw macOS-Anwendung aus dem Quellcode zu bauen und auszuführen.

## Voraussetzungen

Stellen Sie vor dem Build der App sicher, dass Folgendes installiert ist:

1. **Xcode 26.2+**: Erforderlich für die Swift-Entwicklung.
2. **Node.js 22+ & pnpm**: Erforderlich für Gateway, CLI und Packaging-Skripte.

## 1) Abhängigkeiten installieren

Installieren Sie die projektweiten Abhängigkeiten:

```bash
pnpm install
```

## 2. App bauen und paketieren

Um die macOS-App zu bauen und in `dist/OpenClaw.app` zu paketieren, führen Sie aus:

```bash
./scripts/package-mac-app.sh
```

Wenn Sie kein Apple Developer ID-Zertifikat haben, verwendet das Skript automatisch **Ad-hoc-Signierung** (`-`).

Zu Dev-Ausführungsmodi, Signierungs-Flags und Team-ID-Fehlerbehebung siehe das README der macOS-App:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Hinweis**: Ad-hoc-signierte Apps können Sicherheitsabfragen auslösen. Wenn die App sofort mit „Abort trap 6“ abstürzt, siehe den Abschnitt [Fehlerbehebung](#troubleshooting).

## 3. CLI installieren

Die macOS-App erwartet eine globale `openclaw` CLI-Installation zur Verwaltung von Hintergrundaufgaben.

**So installieren Sie sie (empfohlen):**

1. Öffnen Sie die OpenClaw-App.
2. Wechseln Sie zum Tab **Allgemein**.
3. Klicken Sie auf **„CLI installieren“**.

Alternativ können Sie sie manuell installieren:

```bash
npm install -g openclaw@<version>
```

## Fehlerbehebung

### Build schlägt fehl: Toolchain- oder SDK-Mismatch

Der Build der macOS-App erwartet das neueste macOS SDK und die Swift-6.2-Toolchain.

**Systemabhängigkeiten (erforderlich):**

- **Neueste in der Softwareaktualisierung verfügbare macOS-Version** (erforderlich für Xcode-26.2-SDKs)
- **Xcode 26.2** (Swift-6.2-Toolchain)

**Prüfungen:**

```bash
xcodebuild -version
xcrun swift --version
```

Wenn die Versionen nicht übereinstimmen, aktualisieren Sie macOS/Xcode und führen Sie den Build erneut aus.

### App stürzt beim Erteilen von Berechtigungen ab

Wenn die App abstürzt, wenn Sie **Spracherkennung** oder **Mikrofon**-Zugriff erlauben, kann dies an einem beschädigten TCC-Cache oder einer Signaturabweichung liegen.

**Behebung:**

1. Setzen Sie die TCC-Berechtigungen zurück:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Falls das nicht hilft, ändern Sie vorübergehend `BUNDLE_ID` in [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), um von macOS einen „Clean Slate“ zu erzwingen.

### Gateway bleibt dauerhaft bei „Starting...“

Wenn der Gateway-Status bei „Starting...“ stehen bleibt, prüfen Sie, ob ein Zombie-Prozess den Port blockiert:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Wenn ein manueller Lauf den Port belegt, beenden Sie diesen Prozess (Ctrl+C). Als letzte Maßnahme beenden Sie die oben gefundene PID.
