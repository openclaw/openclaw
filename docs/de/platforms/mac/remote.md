---
summary: "„macOS-App-Ablauf zur Steuerung eines entfernten OpenClaw Gateway über SSH“"
read_when:
  - Beim Einrichten oder Debuggen der entfernten macOS-Steuerung
title: "Fernbedienung"
---

# Remote OpenClaw (macOS ⇄ entfernter Host)

Dieser Ablauf ermöglicht es der macOS-App, als vollständige Fernsteuerung für ein OpenClaw Gateway zu fungieren, das auf einem anderen Host (Desktop/Server) läuft. Es handelt sich um die Funktion **Remote over SSH** (Remote-Ausführung) der App. Alle Funktionen – Health-Checks, Voice-Wake-Weiterleitung und Web Chat – verwenden dieselbe entfernte SSH-Konfiguration aus _Einstellungen → Allgemein_.

## Modi

- **Lokal (dieser Mac)**: Alles läuft auf dem Laptop. Kein SSH erforderlich.
- **Remote over SSH (Standard)**: OpenClaw-Befehle werden auf dem entfernten Host ausgeführt. Die Mac-App öffnet eine SSH-Verbindung mit `-o BatchMode` sowie Ihrer gewählten Identität/Ihrem Schlüssel und einem lokalen Port-Forward.
- **Remote direkt (ws/wss)**: Kein SSH-Tunnel. Die Mac-App verbindet sich direkt mit der Gateway-URL (z. B. über Tailscale Serve oder einen öffentlichen HTTPS-Reverse-Proxy).

## Remote-Transporte

Der Remote-Modus unterstützt zwei Transporte:

- **SSH-Tunnel** (Standard): Verwendet `ssh -N -L ...`, um den Gateway-Port an localhost weiterzuleiten. Das Gateway sieht die IP des Nodes als `127.0.0.1`, da der Tunnel über loopback läuft.
- **Direkt (ws/wss)**: Stellt eine direkte Verbindung zur Gateway-URL her. Das Gateway sieht die echte Client-IP.

## Voraussetzungen auf dem entfernten Host

1. Installieren Sie Node + pnpm und bauen/installieren Sie die OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).
2. Stellen Sie sicher, dass `openclaw` für nicht-interaktive Shells im PATH enthalten ist (bei Bedarf Symlink nach `/usr/local/bin` oder `/opt/homebrew/bin`).
3. Öffnen Sie SSH mit Schlüssel-Authentifizierung. Für stabile Erreichbarkeit außerhalb des LAN empfehlen wir **Tailscale**-IPs.

## macOS-App-Einrichtung

1. Öffnen Sie _Einstellungen → Allgemein_.
2. Wählen Sie unter **OpenClaw läuft** **Remote over SSH** und konfigurieren Sie:
   - **Transport**: **SSH-Tunnel** oder **Direkt (ws/wss)**.
   - **SSH-Ziel**: `user@host` (optional `:port`).
     - Befindet sich das Gateway im selben LAN und kündigt sich per Bonjour an, wählen Sie es aus der entdeckten Liste aus, um dieses Feld automatisch auszufüllen.
   - **Gateway-URL** (nur Direkt): `wss://gateway.example.ts.net` (oder `ws://...` für lokal/LAN).
   - **Identity-Datei** (erweitert): Pfad zu Ihrem Schlüssel.
   - **Projekt-Root** (erweitert): Pfad des entfernten Checkouts, der für Befehle verwendet wird.
   - **CLI-Pfad** (erweitert): optionaler Pfad zu einem ausführbaren `openclaw`-Entrypoint/Binary (automatisch ausgefüllt, wenn angekündigt).
3. Klicken Sie auf **Remote testen**. Ein Erfolg zeigt an, dass das entfernte `openclaw status --json` korrekt läuft. Fehler deuten meist auf PATH-/CLI-Probleme hin; Exit 127 bedeutet, dass die CLI remote nicht gefunden wird.
4. Health-Checks und Web Chat laufen nun automatisch über diesen SSH-Tunnel.

## Web Chat

- **SSH-Tunnel**: Web Chat verbindet sich über den weitergeleiteten WebSocket-Control-Port (Standard 18789) mit dem Gateway.
- **Direkt (ws/wss)**: Web Chat verbindet sich direkt mit der konfigurierten Gateway-URL.
- Es gibt keinen separaten WebChat-HTTP-Server mehr.

## Berechtigungen

- Der entfernte Host benötigt dieselben TCC-Freigaben wie lokal (Automation, Bedienungshilfen, Bildschirmaufnahme, Mikrofon, Spracherkennung, Mitteilungen). Führen Sie das Onboarding auf dieser Maschine einmal aus, um sie zu erteilen.
- Nodes kündigen ihren Berechtigungsstatus über `node.list` / `node.describe` an, damit Agents wissen, was verfügbar ist.

## Sicherheitshinweise

- Bevorzugen Sie loopback-Bindings auf dem entfernten Host und verbinden Sie sich über SSH oder Tailscale.
- Wenn Sie das Gateway an eine Nicht-loopback-Schnittstelle binden, verlangen Sie Token-/Passwort-Authentifizierung.
- Siehe [Security](/gateway/security) und [Tailscale](/gateway/tailscale).

## WhatsApp-Anmeldefluss (remote)

- Führen Sie `openclaw channels login --verbose` **auf dem entfernten Host** aus. Scannen Sie den QR-Code mit WhatsApp auf Ihrem Telefon.
- Wiederholen Sie die Anmeldung auf diesem Host, wenn die Authentifizierung abläuft. Der Health-Check macht Verbindungsprobleme sichtbar.

## Fehlerbehebung

- **exit 127 / not found**: `openclaw` ist für Nicht-Login-Shells nicht im PATH. Fügen Sie es zu `/etc/paths`, Ihrer Shell-rc hinzu oder legen Sie einen Symlink nach `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: Prüfen Sie die SSH-Erreichbarkeit, den PATH und dass Baileys angemeldet ist (`openclaw status --json`).
- **Web Chat hängt**: Stellen Sie sicher, dass das Gateway auf dem entfernten Host läuft und der weitergeleitete Port dem Gateway-WS-Port entspricht; die UI erfordert eine funktionierende WS-Verbindung.
- **Node-IP zeigt 127.0.0.1**: Erwartet beim SSH-Tunnel. Wechseln Sie **Transport** zu **Direkt (ws/wss)**, wenn das Gateway die echte Client-IP sehen soll.
- **Voice Wake**: Trigger-Phrasen werden im Remote-Modus automatisch weitergeleitet; kein separater Forwarder erforderlich.

## Benachrichtigungstöne

Wählen Sie Töne pro Benachrichtigung aus Skripten mit `openclaw` und `node.invoke`, z. B.:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Es gibt in der App keinen globalen Schalter „Standardton“ mehr; Aufrufer wählen pro Anfrage einen Ton (oder keinen).
