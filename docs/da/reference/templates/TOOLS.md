---
summary: "Workspace-skabelon til TOOLS.md"
read_when:
  - Manuel bootstrap af et workspace
x-i18n:
  source_path: reference/templates/TOOLS.md
  source_hash: 3ed08cd537620749
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:35Z
---

# TOOLS.md - Lokale noter

Skills definerer _hvordan_ værktøjer fungerer. Denne fil er til _dine_ detaljer — det, der er unikt for din opsætning.

## Hvad hører til her

Ting som:

- Kameranavne og -placeringer
- SSH-værter og aliaser
- Foretrukne stemmer til TTS
- Højttaler-/rumnavne
- Enheders kaldenavne
- Alt, der er miljøspecifikt

## Eksempler

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Hvorfor adskille det?

Skills deles. Din opsætning er din. Ved at holde dem adskilt kan du opdatere skills uden at miste dine noter og dele skills uden at lække din infrastruktur.

---

Tilføj det, der hjælper dig med at gøre dit arbejde. Dette er dit snydeark.
