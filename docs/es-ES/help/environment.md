---
summary: "Dónde carga OpenClaw las variables de entorno y el orden de precedencia"
read_when:
  - Necesitas saber qué variables de entorno se cargan y en qué orden
  - Estás depurando claves de API faltantes en el Gateway
  - Estás documentando autenticación de proveedores o entornos de despliegue
title: "Variables de Entorno"
---

# Variables de entorno

OpenClaw obtiene variables de entorno de múltiples fuentes. La regla es **nunca sobrescribir valores existentes**.

## Precedencia (mayor → menor)

1. **Entorno del proceso** (lo que el proceso Gateway ya tiene del shell/demonio padre).
2. **`.env` en el directorio de trabajo actual** (dotenv por defecto; no sobrescribe).
3. **`.env` global** en `~/.openclaw/.env` (también conocido como `$OPENCLAW_STATE_DIR/.env`; no sobrescribe).
4. **Bloque `env` del Config** en `~/.openclaw/openclaw.json` (aplicado solo si falta).
5. **Importación opcional de login-shell** (`env.shellEnv.enabled` o `OPENCLAW_LOAD_SHELL_ENV=1`), aplicado solo para claves esperadas faltantes.

Si falta completamente el archivo de configuración, se omite el paso 4; la importación de shell aún se ejecuta si está habilitada.

## Bloque `env` del Config

Dos formas equivalentes de establecer variables de entorno en línea (ambas no sobrescriben):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Importación de env de shell

`env.shellEnv` ejecuta tu shell de inicio de sesión e importa solo las claves esperadas **faltantes**:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Equivalentes de variables de entorno:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Sustitución de variables de entorno en config

Puedes referenciar variables de entorno directamente en valores de cadena de config usando la sintaxis `${VAR_NAME}`:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

Ver [Configuración: Sustitución de variables de entorno](/es-ES/gateway/configuration#env-var-substitution-in-config) para detalles completos.

## Variables de entorno relacionadas con rutas

| Variable               | Propósito                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_HOME`        | Sobrescribe el directorio home usado para toda resolución de rutas internas (`~/.openclaw/`, directorios de agentes, sesiones, credenciales). Útil al ejecutar OpenClaw como usuario de servicio dedicado. |
| `OPENCLAW_STATE_DIR`   | Sobrescribe el directorio de estado (por defecto `~/.openclaw`).                                                                                                                                           |
| `OPENCLAW_CONFIG_PATH` | Sobrescribe la ruta del archivo de configuración (por defecto `~/.openclaw/openclaw.json`).                                                                                                                |

### `OPENCLAW_HOME`

Cuando se establece, `OPENCLAW_HOME` reemplaza el directorio home del sistema (`$HOME` / `os.homedir()`) para toda resolución de rutas internas. Esto permite aislamiento completo del sistema de archivos para cuentas de servicio sin cabeza.

**Precedencia:** `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

**Ejemplo** (macOS LaunchDaemon):

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPENCLAW_HOME</key>
  <string>/Users/kira</string>
</dict>
```

`OPENCLAW_HOME` también se puede establecer como una ruta tilde (ej. `~/svc`), que se expande usando `$HOME` antes de usarse.

## Relacionado

- [Configuración del Gateway](/es-ES/gateway/configuration)
- [Preguntas frecuentes: variables de entorno y carga .env](/es-ES/help/faq#env-vars-and-env-loading)
- [Resumen de modelos](/es-ES/concepts/models)
