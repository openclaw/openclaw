---
summary: "Referencia de la CLI para `openclaw configure` (prompts interactivos de configuración)"
read_when:
  - Quiere ajustar credenciales, dispositivos o valores predeterminados del agente de forma interactiva
title: "configure"
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:46Z
---

# `openclaw configure`

Prompt interactivo para configurar credenciales, dispositivos y valores predeterminados del agente.

Nota: La sección **Modelo** ahora incluye una selección múltiple para la lista de permitidos
`agents.defaults.models` (lo que aparece en `/model` y en el selector de modelos).

Consejo: `openclaw config` sin un subcomando abre el mismo asistente. Use
`openclaw config get|set|unset` para ediciones no interactivas.

Relacionado:

- Referencia de configuración del Gateway: [Configuration](/gateway/configuration)
- CLI de Config: [Config](/cli/config)

Notas:

- Elegir dónde se ejecuta el Gateway siempre actualiza `gateway.mode`. Puede seleccionar "Continue" sin otras secciones si eso es todo lo que necesita.
- Los servicios orientados a canales (Slack/Discord/Matrix/Microsoft Teams) solicitan listas de permitidos de canales/salas durante la configuración. Puede introducir nombres o ID; el asistente resuelve nombres a ID cuando es posible.

## Ejemplos

```bash
openclaw configure
openclaw configure --section models --section channels
```
