---
summary: "Visión general de configuración: tareas comunes, configuración rápida y enlaces a la referencia completa"
read_when:
  - Configurando OpenClaw por primera vez
  - Buscando patrones comunes de configuración
  - Navegando a secciones específicas de configuración
title: "Configuración"
---

# Configuración

OpenClaw lee un archivo <Tooltip tip="JSON5 soporta comentarios y comas finales">**JSON5**</Tooltip> opcional desde `~/.openclaw/openclaw.json`.

Si el archivo no existe, OpenClaw usa valores predeterminados seguros. Razones comunes para agregar una configuración:

- Conectar canales y controlar quién puede enviar mensajes al bot
- Configurar modelos, herramientas, sandboxing o automatización (cron, hooks)
- Ajustar sesiones, medios, redes o interfaz de usuario

Consulta la [referencia completa](/es-ES/gateway/configuration-reference) para todos los campos disponibles.

<Tip>
**¿Nuevo en la configuración?** Comienza con `openclaw onboard` para configuración interactiva, o revisa la guía de [Ejemplos de Configuración](/es-ES/gateway/configuration-examples) para configuraciones completas listas para copiar y pegar.
</Tip>

## Configuración mínima

```json5
// ~/.openclaw/openclaw.json
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

## Edición de configuración

<Tabs>
  <Tab title="Asistente interactivo">
    ```bash
    openclaw onboard       # asistente de configuración completo
    openclaw configure     # asistente de config
    ```
  </Tab>
  <Tab title="CLI (una línea)">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset tools.web.search.apiKey
    ```
  </Tab>
  <Tab title="Interfaz de Control">
    Abre [http://127.0.0.1:18789](http://127.0.0.1:18789) y usa la pestaña **Config**.
    La Interfaz de Control renderiza un formulario desde el esquema de configuración, con un editor **Raw JSON** como alternativa.
  </Tab>
  <Tab title="Edición directa">
    Edita `~/.openclaw/openclaw.json` directamente. El Gateway observa el archivo y aplica los cambios automáticamente (ver [recarga en caliente](#config-hot-reload)).
  </Tab>
</Tabs>

## Validación estricta

<Warning>
OpenClaw solo acepta configuraciones que coincidan completamente con el esquema. Claves desconocidas, tipos malformados o valores inválidos hacen que el Gateway **se niegue a iniciar**. La única excepción a nivel raíz es `$schema` (string), para que los editores puedan adjuntar metadatos de JSON Schema.
</Warning>

Cuando la validación falla:

- El Gateway no arranca
- Solo funcionan comandos de diagnóstico (`openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`)
- Ejecuta `openclaw doctor` para ver los problemas exactos
- Ejecuta `openclaw doctor --fix` (o `--yes`) para aplicar reparaciones

## Tareas comunes

<AccordionGroup>
  <Accordion title="Configurar un canal (WhatsApp, Telegram, Discord, etc.)">
    Cada canal tiene su propia sección de configuración bajo `channels.<provider>`. Consulta la página dedicada del canal para los pasos de configuración:

    - [WhatsApp](/es-ES/channels/whatsapp) — `channels.whatsapp`
    - [Telegram](/es-ES/channels/telegram) — `channels.telegram`
    - [Discord](/es-ES/channels/discord) — `channels.discord`
    - [Slack](/es-ES/channels/slack) — `channels.slack`
    - [Signal](/es-ES/channels/signal) — `channels.signal`
    - [iMessage](/es-ES/channels/imessage) — `channels.imessage`
    - [Google Chat](/es-ES/channels/googlechat) — `channels.googlechat`
    - [Mattermost](/es-ES/channels/mattermost) — `channels.mattermost`
    - [MS Teams](/es-ES/channels/msteams) — `channels.msteams`

    Todos los canales comparten el mismo patrón de política de mensajes directos:

    ```json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // solo para allowlist/open
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Elegir y configurar modelos">
    Configura el modelo primario y respaldos opcionales:

    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5",
            fallbacks: ["openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
            "openai/gpt-5.2": { alias: "GPT" },
          },
        },
      },
    }
    ```

    - `agents.defaults.models` define el catálogo de modelos y actúa como lista de permitidos para `/model`.
    - Las referencias de modelo usan formato `provider/model` (ej. `anthropic/claude-opus-4-6`).
    - Ver [Modelos CLI](/es-ES/concepts/models) para cambiar modelos en el chat y [Failover de Modelos](/es-ES/concepts/model-failover) para rotación de autenticación y comportamiento de respaldo.
    - Para proveedores personalizados/auto-alojados, ver [Proveedores personalizados](/es-ES/gateway/configuration-reference#custom-providers-and-base-urls) en la referencia.

  </Accordion>

  <Accordion title="Controlar quién puede enviar mensajes al bot">
    El acceso a mensajes directos se controla por canal mediante `dmPolicy`:

    - `"pairing"` (predeterminado): remitentes desconocidos reciben un código de emparejamiento único para aprobar
    - `"allowlist"`: solo remitentes en `allowFrom` (o el almacén de permitidos emparejados)
    - `"open"`: permitir todos los mensajes directos entrantes (requiere `allowFrom: ["*"]`)
    - `"disabled"`: ignorar todos los mensajes directos

    Para grupos, usa `groupPolicy` + `groupAllowFrom` o listas de permitidos específicas del canal.

    Ver la [referencia completa](/es-ES/gateway/configuration-reference#dm-and-group-access) para detalles por canal.

  </Accordion>

  <Accordion title="Configurar control de menciones en chats grupales">
    Los mensajes de grupo requieren **mención** por defecto. Configura patrones por agente:

    ```json5
    {
      agents: {
        list: [
          {
            id: "main",
            groupChat: {
              mentionPatterns: ["@openclaw", "openclaw"],
            },
          },
        ],
      },
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: true } },
        },
      },
    }
    ```

    - **Menciones de metadatos**: menciones @ nativas (mención táctil de WhatsApp, @bot de Telegram, etc.)
    - **Patrones de texto**: patrones regex en `mentionPatterns`
    - Ver [referencia completa](/es-ES/gateway/configuration-reference#group-chat-mention-gating) para anulaciones por canal y modo de auto-chat.

  </Accordion>

  <Accordion title="Configurar sesiones y reinicios">
    Las sesiones controlan la continuidad y el aislamiento de la conversación:

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // recomendado para multi-usuario
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

    - `dmScope`: `main` (compartido) | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - Ver [Gestión de Sesiones](/es-ES/concepts/session) para alcance, enlaces de identidad y política de envío.
    - Ver [referencia completa](/es-ES/gateway/configuration-reference#session) para todos los campos.

  </Accordion>

  <Accordion title="Habilitar sandboxing">
    Ejecuta sesiones de agentes en contenedores Docker aislados:

    ```json5
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",  // off | non-main | all
            scope: "agent",    // session | agent | shared
          },
        },
      },
    }
    ```

    Construye la imagen primero: `scripts/sandbox-setup.sh`

    Ver [Sandboxing](/es-ES/gateway/sandboxing) para la guía completa y [referencia completa](/es-ES/gateway/configuration-reference#sandbox) para todas las opciones.

  </Accordion>

  <Accordion title="Configurar heartbeat (verificaciones periódicas)">
    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
    }
    ```

    - `every`: cadena de duración (`30m`, `2h`). Establece `0m` para deshabilitar.
    - `target`: `last` | `whatsapp` | `telegram` | `discord` | `none`
    - Ver [Heartbeat](/es-ES/gateway/heartbeat) para la guía completa.

  </Accordion>

  <Accordion title="Configurar tareas programadas">
    ```json5
    {
      cron: {
        enabled: true,
        maxConcurrentRuns: 2,
        sessionRetention: "24h",
      },
    }
    ```

    Ver [Tareas programadas](/es-ES/automation/cron-jobs) para la visión general de funciones y ejemplos CLI.

  </Accordion>

  <Accordion title="Configurar webhooks (hooks)">
    Habilita endpoints de webhook HTTP en el Gateway:

    ```json5
    {
      hooks: {
        enabled: true,
        token: "shared-secret",
        path: "/hooks",
        defaultSessionKey: "hook:ingress",
        allowRequestSessionKey: false,
        allowedSessionKeyPrefixes: ["hook:"],
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            agentId: "main",
            deliver: true,
          },
        ],
      },
    }
    ```

    Ver [referencia completa](/es-ES/gateway/configuration-reference#hooks) para todas las opciones de mapeo e integración con Gmail.

  </Accordion>

  <Accordion title="Configurar enrutamiento multi-agente">
    Ejecuta múltiples agentes aislados con espacios de trabajo y sesiones separados:

    ```json5
    {
      agents: {
        list: [
          { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
          { id: "work", workspace: "~/.openclaw/workspace-work" },
        ],
      },
      bindings: [
        { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
        { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
      ],
    }
    ```

    Ver [Multi-Agente](/es-ES/concepts/multi-agent) y [referencia completa](/es-ES/gateway/configuration-reference#multi-agent-routing) para reglas de vinculación y perfiles de acceso por agente.

  </Accordion>

  <Accordion title="Dividir configuración en múltiples archivos ($include)">
    Usa `$include` para organizar configuraciones grandes:

    ```json5
    // ~/.openclaw/openclaw.json
    {
      gateway: { port: 18789 },
      agents: { $include: "./agents.json5" },
      broadcast: {
        $include: ["./clients/a.json5", "./clients/b.json5"],
      },
    }
    ```

    - **Archivo único**: reemplaza el objeto contenedor
    - **Array de archivos**: fusionados profundamente en orden (el último gana)
    - **Claves hermanas**: fusionadas después de includes (anulan valores incluidos)
    - **Includes anidados**: soportados hasta 10 niveles de profundidad
    - **Rutas relativas**: resueltas relativas al archivo que incluye
    - **Manejo de errores**: errores claros para archivos faltantes, errores de análisis e includes circulares

  </Accordion>
</AccordionGroup>

## Recarga en caliente de configuración

El Gateway observa `~/.openclaw/openclaw.json` y aplica los cambios automáticamente — no se necesita reinicio manual para la mayoría de las configuraciones.

### Modos de recarga

| Modo                   | Comportamiento                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| **`hybrid`** (predeterminado) | Aplica cambios seguros en caliente instantáneamente. Reinicia automáticamente para los críticos. |
| **`hot`**              | Aplica solo cambios seguros en caliente. Registra una advertencia cuando se necesita un reinicio — tú lo manejas. |
| **`restart`**          | Reinicia el Gateway con cualquier cambio de configuración, seguro o no.                       |
| **`off`**              | Deshabilita la observación de archivos. Los cambios tienen efecto en el próximo reinicio manual. |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
```

### Qué se aplica en caliente vs qué necesita reinicio

La mayoría de los campos se aplican en caliente sin tiempo de inactividad. En modo `hybrid`, los cambios que requieren reinicio se manejan automáticamente.

| Categoría            | Campos                                                               | ¿Reinicio necesario? |
| -------------------- | -------------------------------------------------------------------- | -------------------- |
| Canales              | `channels.*`, `web` (WhatsApp) — todos los canales integrados y de extensión | No                   |
| Agente y modelos     | `agent`, `agents`, `models`, `routing`                               | No                   |
| Automatización       | `hooks`, `cron`, `agent.heartbeat`                                   | No                   |
| Sesiones y mensajes  | `session`, `messages`                                                | No                   |
| Herramientas y medios| `tools`, `browser`, `skills`, `audio`, `talk`                        | No                   |
| UI y varios          | `ui`, `logging`, `identity`, `bindings`                              | No                   |
| Servidor Gateway     | `gateway.*` (port, bind, auth, tailscale, TLS, HTTP)                 | **Sí**               |
| Infraestructura      | `discovery`, `canvasHost`, `plugins`                                 | **Sí**               |

<Note>
`gateway.reload` y `gateway.remote` son excepciones — cambiarlos **no** activa un reinicio.
</Note>

## RPC de configuración (actualizaciones programáticas)

<AccordionGroup>
  <Accordion title="config.apply (reemplazo completo)">
    Valida + escribe la configuración completa y reinicia el Gateway en un solo paso.

    <Warning>
    `config.apply` reemplaza la **configuración completa**. Usa `config.patch` para actualizaciones parciales, o `openclaw config set` para claves individuales.
    </Warning>

    Parámetros:

    - `raw` (string) — payload JSON5 para toda la configuración
    - `baseHash` (opcional) — hash de configuración de `config.get` (requerido cuando existe la configuración)
    - `sessionKey` (opcional) — clave de sesión para el ping de activación post-reinicio
    - `note` (opcional) — nota para el centinela de reinicio
    - `restartDelayMs` (opcional) — retraso antes del reinicio (predeterminado 2000)

    ```bash
    openclaw gateway call config.get --params '{}'  # capturar payload.hash
    openclaw gateway call config.apply --params '{
      "raw": "{ agents: { defaults: { workspace: \"~/.openclaw/workspace\" } } }",
      "baseHash": "<hash>",
      "sessionKey": "agent:main:whatsapp:dm:+15555550123"
    }'
    ```

  </Accordion>

  <Accordion title="config.patch (actualización parcial)">
    Fusiona una actualización parcial en la configuración existente (semántica de JSON merge patch):

    - Los objetos se fusionan recursivamente
    - `null` elimina una clave
    - Los arrays se reemplazan

    Parámetros:

    - `raw` (string) — JSON5 con solo las claves a cambiar
    - `baseHash` (requerido) — hash de configuración de `config.get`
    - `sessionKey`, `note`, `restartDelayMs` — igual que `config.apply`

    ```bash
    openclaw gateway call config.patch --params '{
      "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
      "baseHash": "<hash>"
    }'
    ```

  </Accordion>
</AccordionGroup>

## Variables de entorno

OpenClaw lee variables de entorno del proceso padre más:

- `.env` del directorio de trabajo actual (si está presente)
- `~/.openclaw/.env` (respaldo global)

Ningún archivo anula las variables de entorno existentes. También puedes establecer variables de entorno en línea en la configuración:

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

<Accordion title="Importación de entorno de shell (opcional)">
  Si está habilitado y las claves esperadas no están establecidas, OpenClaw ejecuta tu shell de inicio e importa solo las claves faltantes:

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

Equivalente de variable de entorno: `OPENCLAW_LOAD_SHELL_ENV=1`
</Accordion>

<Accordion title="Sustitución de variables de entorno en valores de configuración">
  Referencia variables de entorno en cualquier valor de cadena de configuración con `${VAR_NAME}`:

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

Reglas:

- Solo nombres en mayúsculas coinciden: `[A-Z_][A-Z0-9_]*`
- Variables faltantes/vacías lanzan un error en tiempo de carga
- Escapa con `$${VAR}` para salida literal
- Funciona dentro de archivos `$include`
- Sustitución en línea: `"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

Ver [Entorno](/es-ES/help/environment) para precedencia completa y fuentes.

## Referencia completa

Para la referencia completa campo por campo, ver **[Referencia de Configuración](/es-ES/gateway/configuration-reference)**.

---

_Relacionado: [Ejemplos de Configuración](/es-ES/gateway/configuration-examples) · [Referencia de Configuración](/es-ES/gateway/configuration-reference) · [Doctor](/es-ES/gateway/doctor)_
