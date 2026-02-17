---
title: Configuración de Habilidades
description: Cómo los agentes cargan la configuración desde archivos de Habilidades
---

Las Habilidades de Agente OpenClaw pueden definir **configuración estructurada** que el agente carga automáticamente y pasa a herramientas o scripts.

## Cómo funciona

1. **Definir el esquema**: Tu `SKILL.md` incluye un bloque delimitado `config-schema`:

   ````markdown
   ```config-schema
   {
     "type": "object",
     "properties": {
       "apiKey": { "type": "string" },
       "endpoint": { "type": "string" }
     }
   }
   ```
   ````

2. **Crear valores de instancia**: Coloca un `config.json` (o `.yaml`) junto a `SKILL.md`:

   ```json
   {
     "apiKey": "sk-...",
     "endpoint": "https://api.example.com"
   }
   ```

3. **Acceder desde herramientas**: Cuando el agente carga tu Habilidad, valida `config.json` contra el esquema y proporciona los valores a cualquier herramienta empaquetada o referenciada.

## Ejemplo

```markdown
# Mi Habilidad de API

Esta Habilidad llama a una API personalizada.

\```config-schema
{
  "type": "object",
  "properties": {
    "token": { "type": "string" }
  },
  "required": ["token"]
}
\```

\```tools
./scripts/call-api.sh
\```
```

**`config.json`:**

```json
{
  "token": "abc123"
}
```

Cuando el agente carga esta Habilidad, `call-api.sh` puede leer `$SKILL_CONFIG_TOKEN` (o sin procesar a través de stdin/args, dependiendo de tu herramienta).

## Esquema y validación

- **Esquema JSON**: Usa JSON Schema estándar (draft-07 o posterior).
- **Validación**: OpenClaw valida en tiempo de carga; errores = la Habilidad no se carga.
- **Valores predeterminados**: Puedes incluir `default` en el esquema.

## Referencias

- [Creando Habilidades](/es-ES/tools/creating-skills) – visión general de empaquetado
- [Herramientas de Habilidades](/es-ES/tools/skills) – uso de Habilidades en agentes
