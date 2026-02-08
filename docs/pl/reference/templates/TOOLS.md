---
summary: „Szablon obszaru roboczego dla TOOLS.md”
read_when:
  - Ręczne bootstrapowanie obszaru roboczego
x-i18n:
  source_path: reference/templates/TOOLS.md
  source_hash: 3ed08cd537620749
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:34Z
---

# TOOLS.md – Notatki lokalne

Skills definiują, _jak_ działają narzędzia. Ten plik jest dla _Twoich_ szczegółów — rzeczy unikatowych dla Twojej konfiguracji.

## Co tu umieścić

Na przykład:

- Nazwy i lokalizacje kamer
- Hosty SSH i aliasy
- Preferowane głosy dla TTS
- Nazwy głośników/pomieszczeń
- Przydomki urządzeń
- Wszystko, co jest specyficzne dla środowiska

## Przykłady

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

## Dlaczego osobno?

Skills są współdzielone. Twoja konfiguracja należy do Ciebie. Rozdzielenie ich oznacza, że możesz aktualizować skills bez utraty swoich notatek oraz udostępniać skills bez ujawniania swojej infrastruktury.

---

Dodaj wszystko, co pomaga Ci wykonywać pracę. To Twoja ściąga.
