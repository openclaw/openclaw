---
summary: "Plantilla de espacio de trabajo para TOOLS.md"
read_when:
  - Arranque de un espacio de trabajo manualmente
x-i18n:
  source_path: reference/templates/TOOLS.md
  source_hash: 3ed08cd537620749
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:34:29Z
---

# TOOLS.md - Notas locales

Skills definen _cómo_ funcionan las herramientas. Este archivo es para _sus_ particularidades — lo que es único de su configuración.

## Qué va aquí

Cosas como:

- Nombres y ubicaciones de cámaras
- Hosts y alias de SSH
- Voces preferidas para TTS
- Nombres de altavoces/salas
- Apodos de dispositivos
- Cualquier cosa específica del entorno

## Ejemplos

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

## ¿Por qué separar?

Skills se comparten. Su configuración es suya. Mantenerlos separados significa que puede actualizar skills sin perder sus notas, y compartir skills sin filtrar su infraestructura.

---

Agregue lo que le ayude a hacer su trabajo. Esta es su chuleta.
