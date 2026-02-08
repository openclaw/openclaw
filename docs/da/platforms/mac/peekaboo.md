---
summary: "PeekabooBridge-integration til macOS UI-automatisering"
read_when:
  - Hosting af PeekabooBridge i OpenClaw.app
  - Integration af Peekaboo via Swift Package Manager
  - Ændring af PeekabooBridge-protokol/stier
title: "Peekaboo Bridge"
x-i18n:
  source_path: platforms/mac/peekaboo.md
  source_hash: b5b9ddb9a7c59e15
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:27Z
---

# Peekaboo Bridge (macOS UI-automatisering)

OpenClaw kan hoste **PeekabooBridge** som en lokal, tilladelsesbevidst broker til UI-automatisering.
Det gør, at `peekaboo` CLI kan styre UI-automatisering, mens macOS-appens TCC-tilladelser genbruges.

## Hvad dette er (og ikke er)

- **Host**: OpenClaw.app kan fungere som PeekabooBridge-host.
- **Klient**: brug `peekaboo` CLI (ingen separat `openclaw ui ...`-overflade).
- **UI**: visuelle overlays forbliver i Peekaboo.app; OpenClaw er en tynd broker-host.

## Aktivér bridgen

I macOS-appen:

- Indstillinger → **Enable Peekaboo Bridge**

Når den er aktiveret, starter OpenClaw en lokal UNIX-socket-server. Hvis den er deaktiveret, stoppes hosten, og `peekaboo` falder tilbage til andre tilgængelige hosts.

## Rækkefølge for klientopdagelse

Peekaboo-klienter prøver typisk hosts i denne rækkefølge:

1. Peekaboo.app (fuld UX)
2. Claude.app (hvis installeret)
3. OpenClaw.app (tynd broker)

Brug `peekaboo bridge status --verbose` for at se, hvilken host der er aktiv, og hvilken socket-sti der er i brug. Du kan tilsidesætte med:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Sikkerhed og tilladelser

- Bridgen validerer **kaldersignaturer**; en tilladelsesliste over TeamIDs håndhæves (Peekaboo-hostens TeamID + OpenClaw-appens TeamID).
- Anmodninger får timeout efter ~10 sekunder.
- Hvis påkrævede tilladelser mangler, returnerer bridgen en tydelig fejlmeddelelse i stedet for at åbne Systemindstillinger.

## Snapshot-adfærd (automatisering)

Snapshots gemmes i hukommelsen og udløber automatisk efter et kort tidsrum.
Hvis du har brug for længere opbevaring, så genindfang fra klienten.

## Fejlfinding

- Hvis `peekaboo` rapporterer “bridge client is not authorized”, skal du sikre, at klienten er korrekt signeret, eller køre hosten med `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` i **debug**-tilstand (kun).
- Hvis ingen hosts findes, så åbn en af host-appsene (Peekaboo.app eller OpenClaw.app) og bekræft, at tilladelser er givet.
