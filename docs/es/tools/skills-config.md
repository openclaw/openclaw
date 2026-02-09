---
summary: "Esquema y ejemplos de la configuración de Skills"
read_when:
  - Al agregar o modificar la configuración de Skills
  - Al ajustar la lista de permitidos integrada o el comportamiento de instalación
title: "Configuración de Skills"
---

# Configuración de Skills

Toda la configuración relacionada con Skills vive bajo `skills` en `~/.openclaw/openclaw.json`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Campos

- `allowBundled`: lista de permitidos opcional solo para Skills **integradas**. Cuando se establece, solo
  las Skills integradas en la lista son elegibles (las Skills administradas/del espacio de trabajo no se ven afectadas).
- `load.extraDirs`: directorios adicionales de Skills para escanear (menor precedencia).
- `load.watch`: observar las carpetas de Skills y actualizar la instantánea de Skills (predeterminado: true).
- `load.watchDebounceMs`: debounce para eventos del observador de Skills en milisegundos (predeterminado: 250).
- `install.preferBrew`: preferir instaladores de brew cuando estén disponibles (predeterminado: true).
- `install.nodeManager`: preferencia del instalador de node (`npm` | `pnpm` | `yarn` | `bun`, predeterminado: npm).
  Esto solo afecta a las **instalaciones de Skills**; el runtime del Gateway debe seguir siendo Node
  (Bun no recomendado para WhatsApp/Telegram).
- `entries.<skillKey>`: anulaciones por Skill.

Campos por Skill:

- `enabled`: establezca `false` para deshabilitar una Skill incluso si está integrada/instalada.
- `env`: variables de entorno inyectadas para la ejecución del agente (solo si no están ya configuradas).
- `apiKey`: conveniencia opcional para Skills que declaran una variable de entorno principal.

## Notas

- Las claves bajo `entries` se asignan al nombre de la Skill de forma predeterminada. Si una Skill define
  `metadata.openclaw.skillKey`, use esa clave en su lugar.
- Los cambios en las Skills se recogen en el siguiente turno del agente cuando el observador está habilitado.

### Skills en sandbox + variables de entorno

Cuando una sesión está **en sandbox**, los procesos de Skills se ejecutan dentro de Docker. El sandbox
**no** hereda el `process.env` del host.

Use una de las siguientes opciones:

- `agents.defaults.sandbox.docker.env` (o `agents.list[].sandbox.docker.env` por agente)
- integrar las variables de entorno en su imagen personalizada de sandbox

Los `env` y `skills.entries.<skill>.env/apiKey` globales se aplican solo a ejecuciones en el **host**.
