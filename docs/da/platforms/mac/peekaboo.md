---
summary: "PeekabooBridge-integration til macOS UI-automatisering"
read_when:
  - Hosting af PeekabooBridge i OpenClaw.app
  - Integration af Peekaboo via Swift Package Manager
  - Ændring af PeekabooBridge-protokol/stier
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (macOS UI-automatisering)

OpenClaw kan være vært for **PeekabooBridge** som en lokal, tilladelsesbevidst UI-automatisering
mægler. Dette lader 'peekaboo' CLI drive UI automatisering, mens du genbruger
macOS app TCC tilladelser.

## Hvad dette er (og ikke er)

- **Host**: OpenClaw.app kan fungere som PeekabooBridge-host.
- **Klient**: brug `peekaboo` CLI (ingen separat `openclaw ui ...`-overflade).
- **UI**: visuelle overlays forbliver i Peekaboo.app; OpenClaw er en tynd broker-host.

## Aktivér bridgen

I macOS-appen:

- Indstillinger → **Enable Peekaboo Bridge**

Når aktiveret, starter OpenClaw en lokal UNIX socket server. Hvis deaktiveret, vil værten
stoppes og `peekaboo` falde tilbage til andre tilgængelige værter.

## Rækkefølge for klientopdagelse

Peekaboo-klienter prøver typisk hosts i denne rækkefølge:

1. Peekaboo.app (fuld UX)
2. Claude.app (hvis installeret)
3. OpenClaw.app (tynd broker)

Brug `peekaboo bro status --verbose` for at se hvilken vært er aktiv, og hvilken
stien er i brug. Du kan tilsidesætte med:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Sikkerhed og tilladelser

- Bridgen validerer **kaldersignaturer**; en tilladelsesliste over TeamIDs håndhæves (Peekaboo-hostens TeamID + OpenClaw-appens TeamID).
- Anmodninger får timeout efter ~10 sekunder.
- Hvis påkrævede tilladelser mangler, returnerer bridgen en tydelig fejlmeddelelse i stedet for at åbne Systemindstillinger.

## Snapshot-adfærd (automatisering)

Snapshots gemmes i hukommelsen og udløber automatisk efter et kort vindue.
Hvis du har brug for længere tilbageholdelse, genindfangning fra kunden.

## Fejlfinding

- Hvis `peekaboo` rapporterer “bridge client is not authorized”, skal du sikre, at klienten er korrekt signeret, eller køre hosten med `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` i **debug**-tilstand (kun).
- Hvis ingen hosts findes, så åbn en af host-appsene (Peekaboo.app eller OpenClaw.app) og bekræft, at tilladelser er givet.
