---
summary: "Arbetsytemall för TOOLS.md"
read_when:
  - Vid manuell bootstrap av en arbetsyta
x-i18n:
  source_path: reference/templates/TOOLS.md
  source_hash: 3ed08cd537620749
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:21Z
---

# TOOLS.md – Lokala anteckningar

Skills definierar _hur_ verktyg fungerar. Den här filen är för _dina_ detaljer — sådant som är unikt för din setup.

## Vad hör hemma här

Till exempel:

- Kameranamnen och deras platser
- SSH-värdar och alias
- Föredragna röster för TTS
- Högtalar-/rumsnamn
- Enheters smeknamn
- Allt som är miljöspecifikt

## Exempel

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

## Varför separera?

Skills delas. Din setup är din. Att hålla dem åtskilda innebär att du kan uppdatera skills utan att förlora dina anteckningar, och dela skills utan att läcka din infrastruktur.

---

Lägg till allt som hjälper dig att göra ditt jobb. Detta är ditt fusklapp.
