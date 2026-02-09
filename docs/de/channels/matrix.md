---
summary: "Status der Matrix-Unterstützung, Funktionen und Konfiguration"
read_when:
  - Arbeiten an Matrix-Kanalfunktionen
title: "Matrix"
---

# Matrix (Plugin)

Matrix ist ein offenes, dezentrales Messaging-Protokoll. OpenClaw verbindet sich als Matrix-**Benutzer**
auf einem beliebigen Homeserver; Sie benötigen daher ein Matrix-Konto für den Bot. Sobald er angemeldet ist, können Sie
dem Bot direkt eine Direktnachricht senden oder ihn in Räume (Matrix-„Gruppen“) einladen. Beeper ist ebenfalls eine gültige Client-Option,
erfordert jedoch aktivierte E2EE.

Status: unterstützt über Plugin (@vector-im/matrix-bot-sdk). Direktnachrichten, Räume, Threads, Medien, Reaktionen,
Umfragen (Senden + Poll-Start als Text), Standort sowie E2EE (mit Krypto-Unterstützung).

## Plugin erforderlich

Matrix wird als Plugin ausgeliefert und ist nicht im Kern-Installationspaket enthalten.

Installation per CLI (npm-Registry):

```bash
openclaw plugins install @openclaw/matrix
```

Lokales Checkout (bei Ausführung aus einem Git-Repo):

```bash
openclaw plugins install ./extensions/matrix
```

Wenn Sie Matrix während der Konfiguration/des Onboardings auswählen und ein Git-Checkout erkannt wird,
bietet OpenClaw den lokalen Installationspfad automatisch an.

Details: [Plugins](/tools/plugin)

## Einrichtung

1. Installieren Sie das Matrix-Plugin:
   - Aus npm: `openclaw plugins install @openclaw/matrix`
   - Aus einem lokalen Checkout: `openclaw plugins install ./extensions/matrix`

2. Erstellen Sie ein Matrix-Konto auf einem Homeserver:
   - Hosting-Optionen finden Sie unter [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Oder hosten Sie es selbst.

3. Besorgen Sie sich ein Zugriffstoken für das Bot-Konto:

   - Verwenden Sie die Matrix-Login-API mit `curl` auf Ihrem Homeserver:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - Ersetzen Sie `matrix.example.org` durch die URL Ihres Homeservers.
   - Oder setzen Sie `channels.matrix.userId` + `channels.matrix.password`: OpenClaw ruft denselben
     Login-Endpunkt auf, speichert das Zugriffstoken in `~/.openclaw/credentials/matrix/credentials.json`
     und verwendet es beim nächsten Start wieder.

4. Konfigurieren Sie die Anmeldedaten:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (oder `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Oder Konfiguration: `channels.matrix.*`
   - Wenn beides gesetzt ist, hat die Konfiguration Vorrang.
   - Mit Zugriffstoken: Die Benutzer-ID wird automatisch über `/whoami` abgerufen.
   - Wenn gesetzt, sollte `channels.matrix.userId` die vollständige Matrix-ID sein (Beispiel: `@bot:example.org`).

5. Starten Sie das Gateway neu (oder schließen Sie das Onboarding ab).

6. Starten Sie eine Direktnachricht mit dem Bot oder laden Sie ihn aus einem beliebigen Matrix-Client
   (Element, Beeper usw.; siehe [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)) in einen Raum ein. Beeper erfordert E2EE,
   setzen Sie daher `channels.matrix.encryption: true` und verifizieren Sie das Gerät.

Minimale Konfiguration (Zugriffstoken, Benutzer-ID automatisch abgerufen):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

E2EE-Konfiguration (Ende-zu-Ende-Verschlüsselung aktiviert):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Verschlüsselung (E2EE)

Ende-zu-Ende-Verschlüsselung wird **unterstützt** über das Rust-Krypto-SDK.

Aktivieren Sie sie mit `channels.matrix.encryption: true`:

- Wenn das Krypto-Modul geladen wird, werden verschlüsselte Räume automatisch entschlüsselt.
- Ausgehende Medien werden beim Senden an verschlüsselte Räume verschlüsselt.
- Bei der ersten Verbindung fordert OpenClaw die Geräteverifizierung von Ihren anderen Sitzungen an.
- Verifizieren Sie das Gerät in einem anderen Matrix-Client (Element usw.), um die Schlüsselweitergabe zu aktivieren. um Schlüsselfreigabe zu aktivieren.
- Wenn das Krypto-Modul nicht geladen werden kann, ist E2EE deaktiviert und verschlüsselte Räume werden nicht entschlüsselt;
  OpenClaw protokolliert eine Warnung.
- Wenn Fehler wegen eines fehlenden Krypto-Moduls auftreten (zum Beispiel `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  erlauben Sie Build-Skripte für `@matrix-org/matrix-sdk-crypto-nodejs` und führen Sie
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` aus oder laden Sie das Binary mit
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

Der Krypto-Zustand wird pro Konto + Zugriffstoken in
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite-Datenbank) gespeichert. Der Sync-Zustand liegt daneben in `bot-storage.json`.
Wenn sich das Zugriffstoken (Gerät) ändert, wird ein neuer Store erstellt und der Bot muss
für verschlüsselte Räume erneut verifiziert werden.

**Geräteverifizierung:**
Wenn E2EE aktiviert ist, fordert der Bot beim Start eine Verifizierung von Ihren anderen Sitzungen an.
Öffnen Sie Element (oder einen anderen Client) und bestätigen Sie die Verifizierungsanfrage, um Vertrauen herzustellen.
Nach der Verifizierung kann der Bot Nachrichten in verschlüsselten Räumen entschlüsseln.

## Routing-Modell

- Antworten gehen immer zurück zu Matrix.
- Direktnachrichten teilen sich die Hauptsitzung des Agenten; Räume werden Gruppensitzungen zugeordnet.

## Zugriffskontrolle (Direktnachrichten)

- Standard: `channels.matrix.dm.policy = "pairing"`. Unbekannte Absender erhalten einen Pairing-Code.
- Freigabe über:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- Öffentliche Direktnachrichten: `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` akzeptiert vollständige Matrix-Benutzer-IDs (Beispiel: `@user:server`). Der Assistent löst Anzeigenamen zu Benutzer-IDs auf, wenn die Verzeichnissuche genau einen eindeutigen Treffer findet.

## Räume (Gruppen)

- Standard: `channels.matrix.groupPolicy = "allowlist"` (Erwähnungs-Gating). Verwenden Sie `channels.defaults.groupPolicy`, um den Standard zu überschreiben, wenn er nicht gesetzt ist.
- Allowlist für Räume mit `channels.matrix.groups` (Raum-IDs oder Aliase; Namen werden zu IDs aufgelöst, wenn die Verzeichnissuche genau einen eindeutigen Treffer findet):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` aktiviert Auto-Antworten in diesem Raum.
- `groups."*"` kann Standardwerte für Erwähnungs-Gating über Räume hinweg festlegen.
- `groupAllowFrom` schränkt ein, welche Absender den Bot in Räumen auslösen können (vollständige Matrix-Benutzer-IDs).
- Pro-Raum-`users`-Allowlists können Absender innerhalb eines bestimmten Raums weiter einschränken (verwenden Sie vollständige Matrix-Benutzer-IDs).
- Der Konfigurationsassistent fragt nach Raum-Allowlists (Raum-IDs, Aliase oder Namen) und löst Namen nur bei einem exakten, eindeutigen Treffer auf.
- Beim Start löst OpenClaw Raum-/Benutzernamen in Allowlists zu IDs auf und protokolliert die Zuordnung; nicht auflösbare Einträge werden für das Allowlist-Matching ignoriert.
- Einladungen werden standardmäßig automatisch angenommen; steuern Sie dies mit `channels.matrix.autoJoin` und `channels.matrix.autoJoinAllowlist`.
- Um **keine Räume** zuzulassen, setzen Sie `channels.matrix.groupPolicy: "disabled"` (oder behalten Sie eine leere Allowlist).
- Legacy-Schlüssel: `channels.matrix.rooms` (gleiche Struktur wie `groups`).

## Threads

- Antwort-Threading wird unterstützt.
- `channels.matrix.threadReplies` steuert, ob Antworten in Threads bleiben:
  - `off`, `inbound` (Standard), `always`
- `channels.matrix.replyToMode` steuert Reply-to-Metadaten, wenn nicht in einem Thread geantwortet wird:
  - `off` (Standard), `first`, `all`

## Funktionen

| Feature           | Status                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Direktnachrichten | ✅ Unterstützt                                                                                                          |
| Räume             | ✅ Unterstützt                                                                                                          |
| Threads           | ✅ Unterstützt                                                                                                          |
| Medien            | ✅ Unterstützt                                                                                                          |
| E2EE              | ✅ Unterstützt (Krypto-Modul erforderlich)                                                           |
| Reaktionen        | ✅ Unterstützt (Senden/Lesen über Werkzeuge)                                                         |
| Umfragen          | ✅ Senden unterstützt; eingehende Poll-Starts werden in Text umgewandelt (Antworten/Enden ignoriert) |
| Standort          | ✅ Unterstützt (Geo-URI; Höhe ignoriert)                                                             |
| Native Befehle    | ✅ Unterstützt                                                                                                          |

## Fehlerbehebung

Führen Sie zuerst diese Abfolge aus:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Bestätigen Sie dann bei Bedarf den Pairing-Status für Direktnachrichten:

```bash
openclaw pairing list matrix
```

Häufige Fehler:

- Angemeldet, aber Raumnachrichten werden ignoriert: Raum durch `groupPolicy` oder Raum-Allowlist blockiert.
- Direktnachrichten werden ignoriert: Absender wartet auf Genehmigung, wenn `channels.matrix.dm.policy="pairing"`.
- Verschlüsselte Räume schlagen fehl: Krypto-Unterstützung oder Verschlüsselungseinstellungen stimmen nicht überein.

Für den Triage-Ablauf: [/channels/troubleshooting](/channels/troubleshooting).

## Konfigurationsreferenz (Matrix)

Vollständige Konfiguration: [Konfiguration](/gateway/configuration)

Anbieteroptionen:

- `channels.matrix.enabled`: Kanalstart aktivieren/deaktivieren.
- `channels.matrix.homeserver`: Homeserver-URL.
- `channels.matrix.userId`: Matrix-Benutzer-ID (optional mit Zugriffstoken).
- `channels.matrix.accessToken`: Zugriffstoken.
- `channels.matrix.password`: Passwort für den Login (Token wird gespeichert).
- `channels.matrix.deviceName`: Anzeigename des Geräts.
- `channels.matrix.encryption`: E2EE aktivieren (Standard: false).
- `channels.matrix.initialSyncLimit`: Initiales Sync-Limit.
- `channels.matrix.threadReplies`: `off | inbound | always` (Standard: eingehend).
- `channels.matrix.textChunkLimit`: Größe der ausgehenden Text-Chunks (Zeichen).
- `channels.matrix.chunkMode`: `length` (Standard) oder `newline`, um vor der Längenaufteilung an Leerzeilen (Absatzgrenzen) zu trennen.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (Standard: Pairing).
- `channels.matrix.dm.allowFrom`: DM-Allowlist (vollständige Matrix-Benutzer-IDs). `open` erfordert `"*"`. Der Assistent löst Namen nach Möglichkeit zu IDs auf.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (Standard: Allowlist).
- `channels.matrix.groupAllowFrom`: Allowlist-Absender für Gruppennachrichten (vollständige Matrix-Benutzer-IDs).
- `channels.matrix.allowlistOnly`: Allowlist-Regeln für Direktnachrichten + Räume erzwingen.
- `channels.matrix.groups`: Gruppen-Allowlist + pro-Raum-Einstellungszuordnung.
- `channels.matrix.rooms`: Legacy-Gruppen-Allowlist/-Konfiguration.
- `channels.matrix.replyToMode`: Reply-to-Modus für Threads/Tags.
- `channels.matrix.mediaMaxMb`: Limit für ein-/ausgehende Medien (MB).
- `channels.matrix.autoJoin`: Einladungsbehandlung (`always | allowlist | off`, Standard: immer).
- `channels.matrix.autoJoinAllowlist`: Zulässige Raum-IDs/Aliase für Auto-Join.
- `channels.matrix.actions`: Werkzeug-Gating pro Aktion (Reaktionen/Nachrichten/Pins/memberInfo/channelInfo).
