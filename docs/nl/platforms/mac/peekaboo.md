---
summary: "PeekabooBridge-integratie voor macOS‑UI-automatisering"
read_when:
  - PeekabooBridge hosten in OpenClaw.app
  - Peekaboo integreren via Swift Package Manager
  - Het PeekabooBridge‑protocol/paden wijzigen
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (macOS‑UI-automatisering)

OpenClaw kan **PeekabooBridge** hosten als een lokale, permissiebewuste UI‑automatiseringsbroker. Dit stelt de `peekaboo` CLI in staat UI‑automatisering aan te sturen terwijl de TCC‑rechten
van de macOS‑app worden hergebruikt.

## Wat dit is (en niet is)

- **Host**: OpenClaw.app kan fungeren als PeekabooBridge‑host.
- **Client**: gebruik de `peekaboo` CLI (geen afzonderlijk `openclaw ui ...`‑oppervlak).
- **UI**: visuele overlays blijven in Peekaboo.app; OpenClaw is een dunne broker‑host.

## De bridge inschakelen

In de macOS‑app:

- Instellingen → **Peekaboo Bridge inschakelen**

Wanneer ingeschakeld start OpenClaw een lokale UNIX‑socketserver. Indien uitgeschakeld,
wordt de host gestopt en zal `peekaboo` terugvallen op andere beschikbare hosts.

## Volgorde voor clientdetectie

Peekaboo‑clients proberen doorgaans hosts in deze volgorde:

1. Peekaboo.app (volledige UX)
2. Claude.app (indien geïnstalleerd)
3. OpenClaw.app (dunne broker)

Gebruik `peekaboo bridge status --verbose` om te zien welke host actief is en welk
socketpad in gebruik is. Je kunt dit overschrijven met:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Beveiliging & rechten

- De bridge valideert **codehandtekeningen van aanroepers**; een toegestane lijst
  van TeamID’s wordt afgedwongen (TeamID van de Peekaboo‑host + TeamID van de OpenClaw‑app).
- Verzoeken verlopen na ~10 seconden.
- Als vereiste rechten ontbreken, retourneert de bridge een duidelijke foutmelding
  in plaats van Systeeminstellingen te openen.

## Snapshotgedrag (automatisering)

Snapshots worden in het geheugen opgeslagen en verlopen automatisch na een korte periode.
Als je langere retentie nodig hebt, leg ze opnieuw vast vanuit de client.

## Problemen oplossen

- Als `peekaboo` meldt “bridge client is not authorized”, zorg dat de client
  correct is ondertekend of voer de host uit met `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`
  uitsluitend in **debug**‑modus.
- Als er geen hosts worden gevonden, open een van de host‑apps (Peekaboo.app of OpenClaw.app)
  en bevestig dat de rechten zijn verleend.
