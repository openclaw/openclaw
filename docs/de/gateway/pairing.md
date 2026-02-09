---
summary: "„Gateway-eigenes Node-Pairing (Option B) für iOS und andere entfernte Nodes“"
read_when:
  - „Implementierung von Genehmigungen für Node-Pairing ohne macOS-UI“
  - „Hinzufügen von CLI-Flows zur Genehmigung entfernter Nodes“
  - „Erweiterung des Gateway-Protokolls um Node-Verwaltung“
title: "Gateway-eigene Paarung"
---

# Gateway-eigenes Pairing (Option B)

Beim Gateway-eigenen Pairing ist das **Gateway** die maßgebliche Instanz dafür, welche Nodes beitreten dürfen. UIs (macOS-App, zukünftige Clients) sind lediglich Frontends, die ausstehende Anfragen genehmigen oder ablehnen.

**Wichtig:** WS-Nodes verwenden **Geräte-Pairing** (Rolle `node`) während `connect`.
`node.pair.*` ist ein separater Pairing-Speicher und steuert den WS-Handshake **nicht**.
Nur Clients, die explizit `node.pair.*` aufrufen, nutzen diesen Flow.

## Konzepte

- **Ausstehende Anfrage**: Eine Node hat um Beitritt gebeten; Genehmigung erforderlich.
- **Gepaarte Node**: Genehmigte Node mit ausgegebenem Auth-Token.
- **Transport**: Der Gateway-WS-Endpunkt leitet Anfragen weiter, entscheidet aber nicht über die Mitgliedschaft. (Legacy-TCP-Bridge-Unterstützung ist veraltet/entfernt.)

## Wie Pairing funktioniert

1. Eine Node verbindet sich mit dem Gateway-WS und fordert Pairing an.
2. Das Gateway speichert eine **ausstehende Anfrage** und sendet `node.pair.requested`.
3. Sie genehmigen oder lehnen die Anfrage ab (CLI oder UI).
4. Bei Genehmigung stellt das Gateway ein **neues Token** aus (Tokens werden beim erneuten Pairing rotiert).
5. Die Node verbindet sich erneut mit dem Token und ist nun „gepaart“.

Ausstehende Anfragen verfallen automatisch nach **5 Minuten**.

## CLI-Workflow (headless-freundlich)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` zeigt gepaarte/verbundene Nodes und deren Fähigkeiten an.

## API-Oberfläche (Gateway-Protokoll)

Events:

- `node.pair.requested` — wird ausgelöst, wenn eine neue ausstehende Anfrage erstellt wird.
- `node.pair.resolved` — wird ausgelöst, wenn eine Anfrage genehmigt/abgelehnt/abgelaufen ist.

Methoden:

- `node.pair.request` — erstellt oder verwendet eine ausstehende Anfrage erneut.
- `node.pair.list` — listet ausstehende + gepaarte Nodes auf.
- `node.pair.approve` — genehmigt eine ausstehende Anfrage (stellt Token aus).
- `node.pair.reject` — lehnt eine ausstehende Anfrage ab.
- `node.pair.verify` — überprüft `{ nodeId, token }`.

Hinweise:

- `node.pair.request` ist pro Node idempotent: Wiederholte Aufrufe geben dieselbe ausstehende Anfrage zurück.
- Die Genehmigung erzeugt **immer** ein neues Token; von `node.pair.request` wird niemals ein Token zurückgegeben.
- Anfragen können `silent: true` als Hinweis für Auto-Genehmigungs-Flows enthalten.

## Auto-Genehmigung (macOS-App)

Die macOS-App kann optional eine **stille Genehmigung** versuchen, wenn:

- die Anfrage als `silent` markiert ist und
- die App eine SSH-Verbindung zum Gateway-Host mit demselben Benutzer verifizieren kann.

Schlägt die stille Genehmigung fehl, wird auf die normale „Genehmigen/Ablehnen“-Abfrage zurückgegriffen.

## Speicherung (lokal, privat)

Der Pairing-Status wird unter dem Gateway-State-Verzeichnis gespeichert (Standard `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Wenn Sie `OPENCLAW_STATE_DIR` überschreiben, wird der Ordner `nodes/` entsprechend mitverschoben.

Sicherheitshinweise:

- Tokens sind Geheimnisse; behandeln Sie `paired.json` als sensibel.
- Das Rotieren eines Tokens erfordert eine erneute Genehmigung (oder das Löschen des Node-Eintrags).

## Transportverhalten

- Der Transport ist **zustandslos**; er speichert keine Mitgliedschaften.
- Wenn das Gateway offline ist oder Pairing deaktiviert ist, können Nodes kein Pairing durchführen.
- Befindet sich das Gateway im Remote-Modus, erfolgt das Pairing weiterhin gegen den Store des entfernten Gateways.
