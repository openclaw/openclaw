---
summary: "macOS Skills-indstillings-UI og gateway-baseret status"
read_when:
  - Opdatering af macOS Skills-indstillings-UI
  - Ændring af gating eller installationsadfærd for Skills
title: "Skills"
x-i18n:
  source_path: platforms/mac/skills.md
  source_hash: ecd5286bbe49eed8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:26Z
---

# Skills (macOS)

macOS-appen viser OpenClaw Skills via gatewayen; den parser ikke Skills lokalt.

## Datakilde

- `skills.status` (gateway) returnerer alle Skills samt berettigelse og manglende krav
  (inklusive tilladelsesliste-blokeringer for bundlede Skills).
- Krav udledes fra `metadata.openclaw.requires` i hver `SKILL.md`.

## Installationshandlinger

- `metadata.openclaw.install` definerer installationsmuligheder (brew/node/go/uv).
- Appen kalder `skills.install` for at køre installatører på gateway-værten.
- Gatewayen viser kun én foretrukken installatør, når der er flere
  (brew når tilgængelig, ellers node manager fra `skills.install`, som standard npm).

## Miljø-/API-nøgler

- Appen gemmer nøgler i `~/.openclaw/openclaw.json` under `skills.entries.<skillKey>`.
- `skills.update` patcher `enabled`, `apiKey` og `env`.

## Fjern-tilstand

- Installation + konfigurationsopdateringer sker på gateway-værten (ikke den lokale Mac).
