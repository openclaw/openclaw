# OpenClaw - Despliegue en Dokploy

## Requisitos previos

- Servidor con Dokploy instalado
- API key de OpenAI (`OPENAI_API_KEY`)
- (Opcional) Bot de Telegram creado vía `@BotFather` (`TELEGRAM_BOT_TOKEN`)

---

## 1. Crear el bot de Telegram

1. Abre Telegram y busca `@BotFather`
2. Envía `/newbot`
3. Sigue las instrucciones (nombre y username del bot)
4. Copia el token que te devuelve (formato: `123456:ABCDEF...`)

## 2. Crear el proyecto en Dokploy

1. En Dokploy, ve a **Projects** > **Create Project**
2. Dale un nombre (ej: `openclaw`)
3. Dentro del proyecto, clic en **+ Create Service** > **Compose** (NO Application)
4. Conecta tu repositorio de GitHub
5. En **Watch Path** pon `/`

> **Importante**: No uses "Application" con Dockerfile. Este setup usa imágenes pre-construidas
> de `ghcr.io`, no necesita buildear nada. Debe ser tipo **Compose**.

## 3. Estructura del proyecto

```
openclaw/
├── docker-compose.yml              # Configuración de servicios
├── config/
│   └── openclaw.json               # Configuración base (modelo, canales)
├── workspace/                      # Personalidad del agente
│   ├── SOUL.md                     # Personalidad y valores
│   ├── IDENTITY.md                 # Nombre, emoji, avatar
│   ├── USER.md                     # Perfil del usuario
│   ├── AGENTS.md                   # Guías de comportamiento
│   ├── TOOLS.md                    # Notas de herramientas
│   └── HEARTBEAT.md                # Tareas periódicas (opcional)
└── DEPLOY-DOKPLOY.md               # Esta guía
```

## 4. docker-compose.yml

```yaml
services:
  openclaw-gateway:
    image: ghcr.io/openclaw/openclaw:latest
    restart: unless-stopped
    user: "root"
    environment:
      HOME: /home/node
      TERM: xterm-256color
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
    volumes:
      - openclaw_config:/home/node/.openclaw
      - openclaw_workspace:/home/node/.openclaw/workspace
      - ./config/openclaw.json:/tmp/openclaw-seed.json:ro
      - ./workspace:/tmp/workspace-seed:ro
    init: true
    expose:
      - "18789"
    networks:
      - dokploy-network
    command:
      [
        "sh",
        "-c",
        "chown -R node:node /home/node/.openclaw && chmod 700 /home/node/.openclaw && [ -s /home/node/.openclaw/openclaw.json ] || cp /tmp/openclaw-seed.json /home/node/.openclaw/openclaw.json && chmod 600 /home/node/.openclaw/openclaw.json && cp -rn /tmp/workspace-seed/* /home/node/.openclaw/workspace/ 2>/dev/null; exec node dist/index.js gateway --bind lan --port 18789 --allow-unconfigured",
      ]

  openclaw-cli:
    image: ghcr.io/openclaw/openclaw:latest
    user: "root"
    environment:
      HOME: /home/node
      TERM: xterm-256color
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      BROWSER: echo
    volumes:
      - openclaw_config:/home/node/.openclaw
      - openclaw_workspace:/home/node/.openclaw/workspace
    stdin_open: true
    tty: true
    init: true
    networks:
      - dokploy-network
    entrypoint: ["node", "dist/index.js"]

volumes:
  openclaw_config:
  openclaw_workspace:

networks:
  dokploy-network:
    external: true
```

### Notas sobre el compose

- `user: "root"`: Necesario para arreglar permisos de los named volumes de Docker
- `--allow-unconfigured`: Permite que el gateway arranque sin ejecutar `openclaw setup`
- `expose` en vez de `ports`: Dokploy maneja el reverse proxy
- `init: true`: Manejo limpio de señales y procesos zombie
- `dokploy-network` (external): Red creada automáticamente por Dokploy
- Named volumes: Persisten datos entre reinicios
- Los archivos de config y workspace se montan en `/tmp/` como seed y se copian al volumen solo si no existen (`cp -n`), para que openclaw pueda escribir en ellos
- El servicio `openclaw-cli` es opcional. Se sale automáticamente (es normal) - solo sirve para ejecutar comandos manuales

## 5. Configuración base (config/openclaw.json)

```json
{
  "gateway": {
    "mode": "local"
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "google/gemini-2.5-pro"
      },
      "compaction": {
        "mode": "safeguard"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      }
    }
  },
  "messages": {
    "ackReactionScope": "group-mentions"
  },
  "commands": {
    "native": "auto",
    "nativeSkills": "auto"
  },
  "plugins": {
    "entries": {
      "telegram": {
        "enabled": true
      }
    }
  }
}
```

### Notas sobre el config

- `gateway.mode: "local"`: Requerido para que el gateway arranque
- `agents.defaults.model.primary`: Define el modelo de IA. Usa formato `provider/model`
- El doctor de OpenClaw puede modificar este archivo al aplicar cambios

### Modelos disponibles (ejemplos)

| Modelo                  | Valor                             |
| ----------------------- | --------------------------------- |
| Gemini 2.5 Pro (actual) | `google/gemini-2.5-pro`           |
| Minimax M2.5            | `openrouter/minimax/minimax-m2.5` |
| GPT-4o                  | `openai/gpt-4o`                   |
| GPT-4o Mini             | `openai/gpt-4o-mini`              |
| Claude Opus             | `anthropic/claude-opus-4`         |
| Claude Sonnet           | `anthropic/claude-sonnet-4.5`     |
| Gemini Pro              | `google/gemini-2.5-pro`           |

## 6. Personalidad del agente (workspace/)

OpenClaw usa archivos Markdown en el workspace para definir la personalidad del bot. Estos archivos se **inyectan en el system prompt en cada turno**.

### SOUL.md - La personalidad core

Define quién es tu bot, sus valores, tono y límites.

```markdown
# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.**
Skip the "Great question!" — just help.

**Have opinions.** You're allowed to disagree, prefer things,
find stuff amusing or boring.

**Be resourceful before asking.** Try to figure it out first.

**Earn trust through competence.** Be careful with external actions.
Be bold with internal ones.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed,
thorough when it matters. Not a corporate drone. Not a sycophant.
Just... good.
```

### IDENTITY.md - Metadata del agente

```markdown
# IDENTITY.md

- **Name:** Clawd
- **Creature:** Helpful lobster AI
- **Vibe:** Sharp, warm, direct
- **Emoji:** 🦞
- **Avatar:** avatars/clawd.png
```

### USER.md - Perfil del humano

```markdown
# USER.md

- **Name:** Gilbert
- **Timezone:** America/Los_Angeles
- **Preferences:** Responde en español, sé directo, no seas formal
```

### AGENTS.md - Guías de comportamiento

```markdown
# AGENTS.md

## Guidelines

- Always check context before responding
- Use tools when available instead of guessing
- Keep responses concise in chat, detailed when asked
- Remember: you're in a Telegram chat, not a terminal
```

### TOOLS.md - Notas del entorno

```markdown
# TOOLS.md

- Running on Dokploy (Docker environment)
- No filesystem access beyond workspace
```

### HEARTBEAT.md - Tareas periódicas (opcional)

```markdown
# HEARTBEAT.md

- Check for pending reminders
- Review any scheduled tasks
```

## 7. Variables de entorno

En Dokploy, sección **Environment**, agrega estas variables:

| Variable                 | Requerida | Descripción               | Ejemplo                |
| ------------------------ | --------- | ------------------------- | ---------------------- |
| `OPENCLAW_GATEWAY_TOKEN` | Sí        | Token interno gateway/CLI | `openssl rand -hex 32` |
| `OPENAI_API_KEY`         | Sí        | API key de OpenAI         | `sk-proj-...`          |
| `TELEGRAM_BOT_TOKEN`     | No        | Token del bot de Telegram | `123456:ABCDEF...`     |
| `DISCORD_BOT_TOKEN`      | No        | Token del bot de Discord  | `MTIz...`              |
| `SLACK_BOT_TOKEN`        | No        | Token del bot de Slack    | `xoxb-...`             |
| `SLACK_APP_TOKEN`        | No        | Token de app de Slack     | `xapp-...`             |

### Generar OPENCLAW_GATEWAY_TOKEN

```bash
openssl rand -hex 32
```

## 8. Desplegar

1. Configura las variables de entorno en Dokploy
2. Haz clic en **Deploy**
3. Verifica en los logs que diga:
   - `[gateway] agent model: openai/gpt-4o`
   - `[telegram] [default] starting provider (@tu_bot)`
4. El contenedor `openclaw-cli` aparecerá como "exited" - eso es **normal**
5. El contenedor `openclaw-gateway` debe aparecer como "running"

## 9. Verificar que funciona

Entra a la **terminal** del contenedor `openclaw-gateway` desde Dokploy:

```bash
cd /app && node dist/index.js channels list
```

> **Nota**: El comando `openclaw` no está en el PATH del contenedor.
> Siempre usa `cd /app && node dist/index.js <comando>`.

## 10. Aprobar pairing de Telegram

1. Escribe cualquier cosa a tu bot en Telegram
2. El bot te responderá con un **código de pairing**
3. En la terminal del gateway, apruébalo:

```bash
cd /app && node dist/index.js pairing approve telegram <CODIGO>
```

O desde SSH en tu servidor:

```bash
docker exec <contenedor-gateway> sh -c "cd /app && node dist/index.js pairing approve telegram <CODIGO>"
```

## 11. Modificar la personalidad después del deploy

Para actualizar SOUL.md u otros archivos después del deploy inicial, tienes dos opciones:

### Opción A: Desde la terminal del gateway

```bash
cd /home/node/.openclaw/workspace
cat > SOUL.md << 'EOF'
# Tu nuevo SOUL.md aqui
EOF
```

Los cambios aplican inmediatamente (hot-reload).

### Opción B: Desde el repo (requiere re-deploy)

1. Edita los archivos en `workspace/` en tu repo
2. Borra los archivos viejos del volumen (desde terminal del gateway):
   ```bash
   rm /home/node/.openclaw/workspace/SOUL.md
   ```
3. Push y re-deploy (el seed se copiará de nuevo)

## 12. Troubleshooting

### "Missing config" / Gateway se reinicia

- Verifica que `--allow-unconfigured` esté en el command
- Verifica que `config/openclaw.json` tenga contenido válido (JSON válido)

### "No API key found for provider anthropic"

- El modelo está apuntando a Anthropic en vez de OpenAI
- Verifica que `openclaw.json` tenga `"primary": "openai/gpt-4o"`
- Si el config del volumen está viejo, bórralo y re-deploy:
  ```bash
  rm /home/node/.openclaw/openclaw.json && kill 1
  ```

### "JSON5: invalid end of input"

- El `openclaw.json` en el volumen está corrupto/vacío
- Borra y re-deploy: `rm /home/node/.openclaw/openclaw.json && kill 1`

### "EBUSY: resource busy or locked"

- El config está montado como bind mount directo (no se puede renombrar)
- Solución: montar como seed en `/tmp/` y copiar (ya implementado en este compose)

### Permisos: "EACCES / EPERM / Owner mismatch"

- Los named volumes se crean como root
- Solución: `user: "root"` + `chown` en el command (ya implementado)

### Error de red al desplegar (connection reset by peer)

- Error temporal de red al bajar la imagen de ghcr.io
- Reintenta el deploy

### El CLI aparece como "exited"

- Es **normal**. Solo sirve para comandos manuales desde la terminal de Dokploy

### El bot no responde en Telegram

- Verifica que `TELEGRAM_BOT_TOKEN` esté en las variables de entorno
- Verifica los logs: debe decir `[telegram] starting provider`
- Si dice "No API key", revisa la sección de modelo arriba

## Canales soportados

| Canal       | Variable de entorno                   | Dificultad |
| ----------- | ------------------------------------- | ---------- |
| Telegram    | `TELEGRAM_BOT_TOKEN`                  | Fácil      |
| Discord     | `DISCORD_BOT_TOKEN`                   | Fácil      |
| Slack       | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | Media      |
| WhatsApp    | Login con QR                          | Media      |
| Google Chat | Service Account JSON                  | Media      |
| Signal      | signal-cli                            | Difícil    |

Para documentación detallada de cada canal, revisa `docs/channels/` en el repositorio.
