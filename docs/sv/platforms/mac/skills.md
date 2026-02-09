---
summary: "macOS-gränssnitt för Skills-inställningar och gateway-baserad status"
read_when:
  - Uppdatering av macOS-gränssnittet för Skills-inställningar
  - Ändring av gating eller installationsbeteende för skills
title: "Skills"
---

# Skills (macOS)

macOS-appen exponerar OpenClaw Skills via gatewayn; den tolkar inte skills lokalt.

## Datakälla

- `skills.status` (gateway) returnerar alla skills samt behörighet och saknade krav
  (inklusive tillåtelselisteblock för paketerade skills).
- Krav härleds från `metadata.openclaw.requires` i varje `SKILL.md`.

## Installationsåtgärder

- `metadata.openclaw.install` definierar installationsalternativ (brew/node/go/uv).
- Appen anropar `skills.install` för att köra installatörer på gateway-värden.
- Gatewayn exponerar endast en föredragen installatör när flera tillhandahålls
  (brew när tillgänglig, annars node manager från `skills.install`, standard npm).

## Miljö-/API-nycklar

- Appen lagrar nycklar i `~/.openclaw/openclaw.json` under `skills.entries.<skillKey>`.
- `skills.update` patchar `enabled`, `apiKey` och `env`.

## Fjärrläge

- Installation och konfigurationsuppdateringar sker på gateway-värden (inte på den lokala Macen).
