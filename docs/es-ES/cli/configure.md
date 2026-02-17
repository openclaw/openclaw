---
summary: "Referencia CLI para `openclaw configure` (prompts de configuración interactivos)"
read_when:
  - Quieres ajustar credenciales, dispositivos o valores predeterminados del agente de forma interactiva
title: "configure"
---

# `openclaw configure`

Prompt interactivo para configurar credenciales, dispositivos y valores predeterminados del agente.

Nota: La sección **Modelo** ahora incluye una selección múltiple para la
lista de permitidos `agents.defaults.models` (lo que aparece en `/model` y el selector de modelo).

Consejo: `openclaw config` sin un subcomando abre el mismo asistente. Usa
`openclaw config get|set|unset` para ediciones no interactivas.

Relacionado:

- Referencia de configuración del Gateway: [Configuración](/es-ES/gateway/configuration)
- CLI de configuración: [Config](/es-ES/cli/config)

Notas:

- Elegir dónde se ejecuta el Gateway siempre actualiza `gateway.mode`. Puedes seleccionar "Continuar" sin otras secciones si eso es todo lo que necesitas.
- Los servicios orientados a canales (Slack/Discord/Matrix/Microsoft Teams) solicitan listas de permitidos de canal/sala durante la configuración. Puedes ingresar nombres o IDs; el asistente resuelve nombres a IDs cuando es posible.

## Ejemplos

```bash
openclaw configure
openclaw configure --section models --section channels
```
