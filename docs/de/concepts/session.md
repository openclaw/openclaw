---
summary: „Regeln, Schlüssel und Persistenz der Sitzungsverwaltung für Chats“
read_when:
  - Ändern der Sitzungsbehandlung oder -speicherung
title: „Sitzungsverwaltung“
x-i18n:
  source_path: concepts/session.md
  source_hash: e2040cea1e0738a8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:36:16Z
---

# Sitzungsverwaltung

OpenClaw behandelt **eine Direktchat-Sitzung pro Agent** als primär. Direktchats werden zu `agent:<agentId>:<mainKey>` (Standard `main`) zusammengeführt, während Gruppen-/Kanalchats eigene Schlüssel erhalten. `session.mainKey` wird berücksichtigt.

Verwenden Sie `session.dmScope`, um zu steuern, wie **Direktnachrichten** gruppiert werden:

- `main` (Standard): Alle DMs teilen die Hauptsitzung für Kontinuität.
- `per-peer`: Isolierung nach Absender-ID über Kanäle hinweg.
- `per-channel-peer`: Isolierung nach Kanal + Absender (empfohlen für Multi-User-Inboxen).
- `per-account-channel-peer`: Isolierung nach Konto + Kanal + Absender (empfohlen für Multi-Account-Inboxen).
  Verwenden Sie `session.identityLinks`, um anbieterpräfixierte Peer-IDs einer kanonischen Identität zuzuordnen, sodass dieselbe Person bei Nutzung von `per-peer`, `per-channel-peer` oder `per-account-channel-peer` eine gemeinsame DM-Sitzung über Kanäle hinweg teilt.

## Sicherer DM-Modus (empfohlen für Multi-User-Setups)

> **Sicherheitswarnung:** Wenn Ihr Agent DMs von **mehreren Personen** empfangen kann, sollten Sie dringend erwägen, den sicheren DM-Modus zu aktivieren. Ohne diesen teilen alle Nutzer denselben Gesprächskontext, was private Informationen zwischen Nutzern preisgeben kann.

**Beispiel für das Problem mit Standardeinstellungen:**

- Alice (`<SENDER_A>`) schreibt Ihrem Agenten zu einem privaten Thema (z. B. einem Arzttermin)
- Bob (`<SENDER_B>`) schreibt Ihrem Agenten und fragt „Worüber haben wir gesprochen?“
- Da beide DMs dieselbe Sitzung teilen, kann das Modell Bob unter Verwendung von Alices vorherigem Kontext antworten.

**Die Lösung:** Setzen Sie `dmScope`, um Sitzungen pro Nutzer zu isolieren:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**Wann aktivieren:**

- Sie haben Pairing-Freigaben für mehr als einen Absender
- Sie verwenden eine DM-Allowlist mit mehreren Einträgen
- Sie setzen `dmPolicy: "open"`
- Mehrere Telefonnummern oder Konten können Ihren Agenten kontaktieren

Hinweise:

- Standard ist `dmScope: "main"` für Kontinuität (alle DMs teilen die Hauptsitzung). Das ist für Single-User-Setups in Ordnung.
- Für Multi-Account-Inboxen im selben Kanal bevorzugen Sie `per-account-channel-peer`.
- Wenn dieselbe Person Sie über mehrere Kanäle kontaktiert, verwenden Sie `session.identityLinks`, um ihre DM-Sitzungen zu einer kanonischen Identität zusammenzuführen.
- Sie können Ihre DM-Einstellungen mit `openclaw security audit` überprüfen (siehe [security](/cli/security)).

## Gateway ist die Quelle der Wahrheit

Der gesamte Sitzungszustand wird **vom Gateway** (dem „Master“-OpenClaw) **besessen**. UI-Clients (macOS-App, WebChat usw.) müssen das Gateway nach Sitzungslisten und Token-Zählern abfragen, statt lokale Dateien zu lesen.

- Im **Remote-Modus** befindet sich der relevante Sitzungsspeicher auf dem entfernten Gateway-Host, nicht auf Ihrem Mac.
- In UIs angezeigte Token-Zähler stammen aus den Store-Feldern des Gateways (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Clients parsen keine JSONL-Transkripte, um Summen zu „korrigieren“.

## Wo der Zustand liegt

- Auf dem **Gateway-Host**:
  - Store-Datei: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (pro Agent).
- Transkripte: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram-Themensitzungen verwenden `.../<SessionId>-topic-<threadId>.jsonl`).
- Der Store ist eine Map `sessionKey -> { sessionId, updatedAt, ... }`. Das Löschen von Einträgen ist sicher; sie werden bei Bedarf neu erstellt.
- Gruppeneinträge können `displayName`, `channel`, `subject`, `room` und `space` enthalten, um Sitzungen in UIs zu kennzeichnen.
- Sitzungseinträge enthalten `origin`-Metadaten (Label + Routing-Hinweise), damit UIs erklären können, woher eine Sitzung stammt.
- OpenClaw liest **keine** alten Pi/Tau-Sitzungsordner.

## Sitzungsbereinigung

OpenClaw kürzt standardmäßig **alte Werkzeugergebnisse** aus dem In-Memory-Kontext unmittelbar vor LLM-Aufrufen.
Dies schreibt die JSONL-Historie **nicht** um. Siehe [/concepts/session-pruning](/concepts/session-pruning).

## Pre-Compaction Memory Flush

Wenn sich eine Sitzung der automatischen Kompaktierung nähert, kann OpenClaw einen **stillen Memory-Flush**
durchführen, der das Modell daran erinnert, dauerhafte Notizen auf die Festplatte zu schreiben. Dies läuft nur,
wenn der Workspace beschreibbar ist. Siehe [Memory](/concepts/memory) und
[Compaction](/concepts/compaction).

## Zuordnung von Transporten → Sitzungsschlüssel

- Direktchats folgen `session.dmScope` (Standard `main`).
  - `main`: `agent:<agentId>:<mainKey>` (Kontinuität über Geräte/Kanäle hinweg).
    - Mehrere Telefonnummern und Kanäle können demselben Agenten-Hauptschlüssel zugeordnet werden; sie fungieren als Transporte in eine Unterhaltung.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId ist standardmäßig `default`).
  - Wenn `session.identityLinks` einer anbieterpräfixierten Peer-ID entspricht (z. B. `telegram:123`), ersetzt der kanonische Schlüssel `<peerId>`, sodass dieselbe Person über Kanäle hinweg eine Sitzung teilt.
- Gruppenchats isolieren den Zustand: `agent:<agentId>:<channel>:group:<id>` (Räume/Kanäle verwenden `agent:<agentId>:<channel>:channel:<id>`).
  - Telegram-Forum-Themen hängen `:topic:<threadId>` an die Gruppen-ID an, um zu isolieren.
  - Alte `group:<id>`-Schlüssel werden für Migration weiterhin erkannt.
- Eingehende Kontexte können weiterhin `group:<id>` verwenden; der Kanal wird aus `Provider` abgeleitet und zur kanonischen Form `agent:<agentId>:<channel>:group:<id>` normalisiert.
- Weitere Quellen:
  - Cron-Jobs: `cron:<job.id>`
  - Webhooks: `hook:<uuid>` (sofern nicht explizit vom Hook gesetzt)
  - Node-Läufe: `node-<nodeId>`

## Lebenszyklus

- Reset-Richtlinie: Sitzungen werden wiederverwendet, bis sie ablaufen; der Ablauf wird bei der nächsten eingehenden Nachricht geprüft.
- Täglicher Reset: Standardmäßig **4:00 Uhr Ortszeit auf dem Gateway-Host**. Eine Sitzung ist veraltet, sobald ihr letztes Update vor der zuletzt erfolgten täglichen Reset-Zeit liegt.
- Leerlauf-Reset (optional): `idleMinutes` fügt ein gleitendes Leerlauffenster hinzu. Wenn tägliche und Leerlauf-Resets konfiguriert sind, erzwingt **der zuerst ablaufende** eine neue Sitzung.
- Legacy nur Leerlauf: Wenn Sie `session.idleMinutes` ohne irgendeine `session.reset`/`resetByType`-Konfiguration setzen, bleibt OpenClaw aus Gründen der Abwärtskompatibilität im Nur-Leerlauf-Modus.
- Überschreibungen pro Typ (optional): `resetByType` ermöglicht es, die Richtlinie für `dm`-, `group`- und `thread`-Sitzungen zu überschreiben (Thread = Slack/Discord-Threads, Telegram-Themen, Matrix-Threads, wenn vom Connector bereitgestellt).
- Überschreibungen pro Kanal (optional): `resetByChannel` überschreibt die Reset-Richtlinie für einen Kanal (gilt für alle Sitzungstypen dieses Kanals und hat Vorrang vor `reset`/`resetByType`).
- Reset-Auslöser: Exakte `/new` oder `/reset` (plus beliebige Extras in `resetTriggers`) starten eine frische Sitzungs-ID und leiten den Rest der Nachricht weiter. `/new <model>` akzeptiert einen Modell-Alias, `provider/model` oder einen Anbieternamen (unscharfe Übereinstimmung), um das neue Sitzungsmodell zu setzen. Wenn `/new` oder `/reset` allein gesendet wird, führt OpenClaw einen kurzen „Hallo“-Begrüßungszug aus, um den Reset zu bestätigen.
- Manueller Reset: Löschen Sie bestimmte Schlüssel aus dem Store oder entfernen Sie das JSONL-Transkript; die nächste Nachricht erstellt sie neu.
- Isolierte Cron-Jobs erzeugen pro Lauf immer eine frische `sessionId` (keine Leerlauf-Wiederverwendung).

## Sende-Richtlinie (optional)

Blockieren Sie die Zustellung für bestimmte Sitzungstypen, ohne einzelne IDs aufzulisten.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

Laufzeit-Override (nur Eigentümer):

- `/send on` → für diese Sitzung zulassen
- `/send off` → für diese Sitzung verweigern
- `/send inherit` → Override löschen und Konfigurationsregeln verwenden
  Senden Sie diese als eigenständige Nachrichten, damit sie registriert werden.

## Konfiguration (optional, Umbenennungsbeispiel)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## Überprüfen

- `openclaw status` — zeigt Store-Pfad und aktuelle Sitzungen.
- `openclaw sessions --json` — gibt jeden Eintrag aus (filtern mit `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — ruft Sitzungen vom laufenden Gateway ab (verwenden Sie `--url`/`--token` für Remote-Gateway-Zugriff).
- Senden Sie `/status` als eigenständige Nachricht im Chat, um zu sehen, ob der Agent erreichbar ist, wie viel des Sitzungskontexts genutzt wird, die aktuellen Thinking-/Verbose-Schalter sowie wann Ihre WhatsApp-Web-Anmeldedaten zuletzt aktualisiert wurden (hilft, Relink-Bedarf zu erkennen).
- Senden Sie `/context list` oder `/context detail`, um zu sehen, was im System-Prompt und in injizierten Workspace-Dateien enthalten ist (und die größten Kontextbeiträger).
- Senden Sie `/stop` als eigenständige Nachricht, um den aktuellen Lauf abzubrechen, ausstehende Follow-ups für diese Sitzung zu löschen und alle davon gestarteten Sub-Agent-Läufe zu stoppen (die Antwort enthält die Anzahl der gestoppten Vorgänge).
- Senden Sie `/compact` (optionale Anweisungen) als eigenständige Nachricht, um älteren Kontext zusammenzufassen und Fensterplatz freizugeben. Siehe [/concepts/compaction](/concepts/compaction).
- JSONL-Transkripte können direkt geöffnet werden, um vollständige Turns zu überprüfen.

## Tipps

- Halten Sie den Primärschlüssel ausschließlich für 1:1-Verkehr; lassen Sie Gruppen ihre eigenen Schlüssel behalten.
- Löschen Sie bei automatisierter Bereinigung einzelne Schlüssel statt des gesamten Stores, um Kontext an anderer Stelle zu erhalten.

## Metadaten zur Sitzungsherkunft

Jeder Sitzungseintrag erfasst bestmöglich, woher er stammt, in `origin`:

- `label`: menschenlesbares Label (aufgelöst aus Gesprächslabel + Gruppenbetreff/Kanal)
- `provider`: normalisierte Kanal-ID (einschließlich Erweiterungen)
- `from`/`to`: rohe Routing-IDs aus dem eingehenden Envelope
- `accountId`: Anbieter-Konto-ID (bei Multi-Account)
- `threadId`: Thread-/Themen-ID, wenn der Kanal dies unterstützt
  Die Herkunftsfelder werden für Direktnachrichten, Kanäle und Gruppen befüllt. Wenn ein
  Connector nur das Zustellungsrouting aktualisiert (z. B. um eine DM-Hauptsitzung
  aktuell zu halten), sollte er dennoch eingehenden Kontext bereitstellen, damit die
  Sitzung ihre erklärenden Metadaten behält. Erweiterungen können dies tun, indem sie
  `ConversationLabel`, `GroupSubject`, `GroupChannel`, `GroupSpace` und `SenderName` im eingehenden
  Kontext senden und `recordSessionMetaFromInbound` aufrufen (oder denselben Kontext an `updateLastRoute` übergeben).
