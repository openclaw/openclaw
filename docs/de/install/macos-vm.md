---
summary: "„Führen Sie OpenClaw in einer sandboxed macOS-VM (lokal oder gehostet) aus, wenn Sie Isolation oder iMessage benötigen“"
read_when:
  - Sie möchten OpenClaw von Ihrer primären macOS-Umgebung isolieren
  - Sie möchten iMessage-Integration (BlueBubbles) in einer Sandbox
  - Sie möchten eine zurücksetzbare macOS-Umgebung, die Sie klonen können
  - Sie möchten lokale vs. gehostete macOS-VM-Optionen vergleichen
title: "„macOS-VMs“"
---

# OpenClaw auf macOS-VMs (Sandboxing)

## Empfohlener Standard (für die meisten Nutzer)

- **Kleiner Linux-VPS** für ein dauerhaft laufendes Gateway und geringe Kosten. Siehe [VPS hosting](/vps).
- **Dedizierte Hardware** (Mac mini oder Linux-Box), wenn Sie volle Kontrolle und eine **Residential IP** für Browser-Automatisierung möchten. Viele Websites blockieren Rechenzentrums-IP-Adressen, daher funktioniert lokales Browsen oft besser.
- **Hybrid:** Betreiben Sie das Gateway auf einem günstigen VPS und verbinden Sie Ihren Mac als **Node**, wenn Sie Browser-/UI-Automatisierung benötigen. Siehe [Nodes](/nodes) und [Gateway remote](/gateway/remote).

Verwenden Sie eine macOS-VM, wenn Sie gezielt macOS-spezifische Funktionen (iMessage/BlueBubbles) benötigen oder eine strikte Isolation von Ihrem täglichen Mac wünschen.

## macOS-VM-Optionen

### Lokale VM auf Ihrem Apple-Silicon-Mac (Lume)

Führen Sie OpenClaw in einer sandboxed macOS-VM auf Ihrem vorhandenen Apple-Silicon-Mac mit [Lume](https://cua.ai/docs/lume) aus.

Das bietet Ihnen:

- Vollständige macOS-Umgebung in Isolation (Ihr Host bleibt sauber)
- iMessage-Unterstützung über BlueBubbles (auf Linux/Windows unmöglich)
- Sofortiges Zurücksetzen durch Klonen von VMs
- Keine zusätzliche Hardware oder Cloud-Kosten

### Gehostete Mac-Anbieter (Cloud)

Wenn Sie macOS in der Cloud möchten, funktionieren gehostete Mac-Anbieter ebenfalls:

- [MacStadium](https://www.macstadium.com/) (gehostete Macs)
- Andere Anbieter für gehostete Macs funktionieren ebenfalls; folgen Sie deren VM- und SSH-Dokumentation

Sobald Sie SSH-Zugriff auf eine macOS-VM haben, fahren Sie unten mit Schritt 6 fort.

---

## Schneller Weg (Lume, erfahrene Nutzer)

1. Lume installieren
2. `lume create openclaw --os macos --ipsw latest`
3. Setup-Assistent abschließen, „Remote Login“ (SSH) aktivieren
4. `lume run openclaw --no-display`
5. Per SSH einloggen, OpenClaw installieren, Kanäle konfigurieren
6. Fertig

---

## Was du brauchst (Lume)

- Apple-Silicon-Mac (M1/M2/M3/M4)
- macOS Sequoia oder neuer auf dem Host
- ~60 GB freier Speicherplatz pro VM
- ~20 Minuten

---

## 1. Lume installieren

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Falls `~/.local/bin` nicht in Ihrem PATH ist:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Überprüfen:

```bash
lume --version
```

Doku: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Die macOS-VM erstellen

```bash
lume create openclaw --os macos --ipsw latest
```

Dadurch wird macOS heruntergeladen und die VM erstellt. Ein VNC-Fenster öffnet sich automatisch.

Hinweis: Der Download kann je nach Verbindung eine Weile dauern.

---

## 3. Setup-Assistent abschließen

Im VNC-Fenster:

1. Sprache und Region auswählen
2. Apple-ID überspringen (oder anmelden, wenn Sie später iMessage möchten)
3. Benutzerkonto erstellen (Benutzername und Passwort merken)
4. Alle optionalen Funktionen überspringen

Nach Abschluss der Einrichtung SSH aktivieren:

1. Systemeinstellungen → Allgemein → Teilen öffnen
2. „Remote Login“ aktivieren

---

## 4. IP-Adresse der VM ermitteln

```bash
lume get openclaw
```

Suchen Sie nach der IP-Adresse (meist `192.168.64.x`).

---

## 5. Per SSH in die VM einloggen

```bash
ssh youruser@192.168.64.X
```

Ersetzen Sie `youruser` durch das von Ihnen erstellte Konto und die IP durch die IP Ihrer VM.

---

## 6. OpenClaw installieren

Innerhalb der VM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Folgen Sie den Onboarding-Aufforderungen, um Ihren Modellanbieter (Anthropic, OpenAI usw.) einzurichten.

---

## 7. Kanäle konfigurieren

Bearbeiten Sie die Konfigurationsdatei:

```bash
nano ~/.openclaw/openclaw.json
```

Fügen Sie Ihre Kanäle hinzu:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Melden Sie sich dann bei WhatsApp an (QR scannen):

```bash
openclaw channels login
```

---

## 8. Die VM headless ausführen

Beenden Sie die VM und starten Sie sie ohne Anzeige neu:

```bash
lume stop openclaw
lume run openclaw --no-display
```

Die VM läuft im Hintergrund. Das OpenClaw-Daemon hält das Gateway am Laufen.

Status prüfen:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bonus: iMessage-Integration

Dies ist das Killer-Feature beim Betrieb unter macOS. Verwenden Sie [BlueBubbles](https://bluebubbles.app), um iMessage zu OpenClaw hinzuzufügen.

Innerhalb der VM:

1. BlueBubbles von bluebubbles.app herunterladen
2. Mit Ihrer Apple-ID anmelden
3. Die Web-API aktivieren und ein Passwort festlegen
4. BlueBubbles-Webhooks auf Ihr Gateway verweisen (Beispiel: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Zur OpenClaw-Konfiguration hinzufügen:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Starten Sie das Gateway neu. Jetzt kann Ihr Agent iMessages senden und empfangen.

Vollständige Setup-Details: [BlueBubbles channel](/channels/bluebubbles)

---

## Golden Image speichern

Bevor Sie weiter anpassen, erstellen Sie einen Snapshot Ihres sauberen Zustands:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Jederzeit zurücksetzen:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Läuft rund um die Uhr

Halten Sie die VM am Laufen durch:

- Ihren Mac am Strom lassen
- Ruhezustand in Systemeinstellungen → Energie sparen deaktivieren
- Falls nötig `caffeinate` verwenden

Für echten Dauerbetrieb erwägen Sie einen dedizierten Mac mini oder einen kleinen VPS. Siehe [VPS hosting](/vps).

---

## Fehlerbehebung

| Problem                    | Lösung                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Kein SSH-Zugriff auf VM    | Prüfen Sie, ob „Remote Login“ in den Systemeinstellungen der VM aktiviert ist                                                               |
| VM-IP wird nicht angezeigt | Warten Sie, bis die VM vollständig gebootet ist, und führen Sie `lume get openclaw` erneut aus                                              |
| Lume-Befehl nicht gefunden | Fügen Sie `~/.local/bin` zu Ihrem PATH hinzu                                                                                                |
| WhatsApp-QR scannt nicht   | Stellen Sie sicher, dass Sie beim Ausführen von `openclaw channels login` in der VM (nicht auf dem Host) angemeldet sind |

---

## Verwandte Dokumente

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (fortgeschritten)
- [Docker Sandboxing](/install/docker) (alternative Isolationsmethode)
