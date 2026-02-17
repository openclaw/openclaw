---
title: Preguntas frecuentes
description: Preguntas comunes sobre OpenClaw, configuración, uso, y solución de problemas
---

## Inicio rápido

### ¿Cómo comienzo a usar OpenClaw?

El camino más rápido:

```bash
npm install -g openclaw
openclaw onboard
```

`openclaw onboard` te guiará a través de:

- Conectar un proveedor de LLM (OpenAI, Anthropic, etc.)
- Configurar tu primera conexión de mensajería (opcional)
- Lanzar el gateway
- Verificar que todo funcione

Una vez completado el onboarding, ejecuta:

```bash
openclaw send "hello"
```

O envía un mensaje desde cualquier canal configurado (WhatsApp, Telegram, etc.).

### ¿Qué sucede en la primera ejecución?

En la primera ejecución, OpenClaw:

1. Crea `~/.openclaw/` y subdirectorios base (`config/`, `sessions/`, `logs/`, `media/`)
2. Genera un `config.toml` predeterminado si no existe
3. Escanea tu entorno en busca de claves API (variables de entorno, archivos `.env`)
4. Puede solicitar credenciales interactivamente si ningún proveedor está configurado
5. Inicia el gateway si se ejecuta `openclaw gateway run`

Después de la primera ejecución, la configuración persiste en `~/.openclaw/config.toml`.

---

## ¿Qué es OpenClaw?

### ¿Qué es OpenClaw?

OpenClaw es un framework de agente de código abierto y autohospedado que te permite:

- Ejecutar agentes LLM localmente o en tu propia infraestructura
- Conectar múltiples canales de mensajería (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, etc.)
- Usar cualquier proveedor de LLM (OpenAI, Anthropic, Google, local, etc.)
- Mantener el control total sobre tus datos y privacidad
- Ejecutar agentes especializados con habilidades y herramientas personalizadas
- Gestionar múltiples sesiones de chat y contextos de conversación

### ¿Qué puede hacer OpenClaw?

OpenClaw puede:

- Responder preguntas usando modelos LLM
- Ejecutar código y comandos (con sandboxing)
- Leer y escribir archivos
- Navegar por la web
- Gestionar múltiples conversaciones simultáneas
- Enrutar mensajes entre canales
- Ejecutar habilidades personalizadas (plugins)
- Integrarse con herramientas externas vía MCP
- Realizar pruebas automatizadas
- Y más...

### ¿Es OpenClaw gratuito?

Sí, OpenClaw es software de código abierto bajo la licencia MIT. Es gratuito para usar, modificar y distribuir.

Sin embargo, necesitarás:

- Acceso API a un proveedor de LLM (algunos son gratuitos, la mayoría son de pago)
- Un servidor o computadora para ejecutar el gateway (puede ser local)
- Opcionalmente, acceso a servicios de mensajería (algunos son gratuitos, algunos requieren suscripciones)

---

## Habilidades y automatización

### ¿Qué son las habilidades?

Las habilidades son plugins especializados que amplían las capacidades del agente. Viven en:

- `~/.agents/skills/` (habilidades de usuario)
- Repo habilidades (`.agents/skills/` en repositorios)

Cada habilidad es un directorio que contiene:

- `SKILL.md` - Instrucciones cargadas en el contexto del agente
- Recursos opcionales (scripts, plantillas, datos de referencia)

Las habilidades pueden:

- Agregar flujos de trabajo especializados (por ejemplo, revisar PRs, depurar, desplegar)
- Inyectar mejores prácticas específicas del dominio
- Proporcionar listas de verificación y plantillas
- Agrupar scripts de ayuda

### ¿Cómo instalo habilidades?

Usa:

```bash
openclaw skills install <skill-name>
```

O clona/crea un directorio de habilidad manualmente en `~/.agents/skills/<skill-name>/`.

### ¿Cómo creo una habilidad personalizada?

1. Crea un directorio:

```bash
mkdir -p ~/.agents/skills/my-skill
```

2. Agrega un archivo `SKILL.md` con instrucciones:

```markdown
# Mi habilidad personalizada

Cuando el usuario pide X, haz Y.

Usa este script auxiliar: `scripts/helper.sh`
```

3. Opcionalmente, agrega recursos:

```bash
mkdir ~/.agents/skills/my-skill/scripts
echo '#!/bin/bash' > ~/.agents/skills/my-skill/scripts/helper.sh
chmod +x ~/.agents/skills/my-skill/scripts/helper.sh
```

4. Carga la habilidad:

```bash
openclaw skills load my-skill
```

Las habilidades se cargan automáticamente si están en `~/.agents/skills/` o en un directorio de habilidades de repositorio.

### ¿Cómo listo las habilidades disponibles?

```bash
openclaw skills list
```

Esto muestra todas las habilidades instaladas y su estado de carga.

### ¿Cómo descargo una habilidad?

Elimina el directorio de la habilidad:

```bash
rm -rf ~/.agents/skills/<skill-name>
```

O usa:

```bash
openclaw skills uninstall <skill-name>
```

Las habilidades se descargan automáticamente del contexto del agente cuando sus directorios se eliminan.

---

## Sandboxing y memoria

### ¿Ejecuta OpenClaw código en un sandbox?

Sí, OpenClaw soporta múltiples estrategias de sandboxing:

- **Código no sandboxed** - El agente ejecuta código directamente en el host (predeterminado)
- **Docker sandbox** - El agente ejecuta código en un contenedor Docker
- **E2B sandbox** - El agente ejecuta código en entornos efímeros de E2B
- **Modal sandbox** - El agente ejecuta código en entornos Modal

Configura sandboxing en `config.toml`:

```toml
[agent.sandbox]
enabled = true
provider = "docker"  # o "e2b", "modal"
```

### ¿Es seguro ejecutar código sin sandbox?

Ejecutar código sin sandbox significa que el agente puede:

- Leer y escribir cualquier archivo al que tu usuario tenga acceso
- Ejecutar cualquier comando que tu usuario pueda ejecutar
- Acceder a la red
- Modificar la configuración del sistema

Usa sandboxing si:

- Ejecutas código que no confías
- Quieres limitar el acceso del agente
- Necesitas entornos reproducibles
- Estás ejecutando OpenClaw en producción

Omite el sandboxing si:

- Confías completamente en el agente
- Necesitas acceso completo al sistema
- Estás ejecutando OpenClaw localmente solo para ti
- Quieres máximo rendimiento

### ¿Cómo habilito el sandboxing Docker?

1. Instala Docker:

```bash
# macOS
brew install --cask docker

# Linux
curl -fsSL https://get.docker.com | sh
```

2. Configura OpenClaw:

```toml
[agent.sandbox]
enabled = true
provider = "docker"
```

3. Ejecuta el agente:

```bash
openclaw send "run echo hello"
```

El agente extraerá/construirá automáticamente una imagen Docker y ejecutará el código dentro del contenedor.

### ¿Qué imagen Docker usa OpenClaw?

Por defecto, OpenClaw usa `node:22-slim`. Puedes personalizarla:

```toml
[agent.sandbox.docker]
image = "python:3.12-slim"
```

O proporciona un `Dockerfile` personalizado:

```toml
[agent.sandbox.docker]
dockerfile = "/path/to/Dockerfile"
```

### ¿Cómo accede el sandbox a archivos?

Por defecto, el sandbox monta:

- El directorio de trabajo actual en `/workspace`
- El directorio de sesión en `/session`

Puedes personalizar los montajes:

```toml
[agent.sandbox.docker]
volumes = [
  "/host/path:/container/path",
  "/another/path:/another/container/path:ro"
]
```

### ¿Recuerda OpenClaw conversaciones pasadas?

Sí, OpenClaw mantiene el historial de sesiones en `~/.openclaw/sessions/`.

Cada sesión se almacena como un archivo JSONL:

```bash
~/.openclaw/sessions/<session-id>.jsonl
```

El agente carga automáticamente el historial de la sesión al reanudar una conversación.

### ¿Cómo borro el historial de conversaciones?

Elimina el archivo de sesión:

```bash
rm ~/.openclaw/sessions/<session-id>.jsonl
```

O usa:

```bash
openclaw sessions clear <session-id>
```

Para borrar todas las sesiones:

```bash
openclaw sessions clear --all
```

### ¿Qué tan larga puede ser una conversación?

Las conversaciones están limitadas por:

- Límites de ventana de contexto del modelo (por ejemplo, 200K tokens para Claude 3.5 Sonnet)
- Espacio en disco para archivos de sesión
- Memoria para mantener el historial en RAM

OpenClaw gestiona automáticamente las conversaciones largas mediante:

- Truncamiento de mensajes antiguos cuando se alcanza el límite de contexto
- Compresión de historial a resúmenes
- Descarga de mensajes antiguos al disco

Puedes controlar el comportamiento de truncamiento en `config.toml`:

```toml
[agent.session]
max_history_tokens = 100000
truncate_strategy = "oldest"  # o "summary", "compress"
```

---

## Dónde viven las cosas en el disco

### ¿Dónde almacena OpenClaw los archivos?

Por defecto, OpenClaw usa `~/.openclaw/`:

```
~/.openclaw/
├── config.toml          # Configuración principal
├── config/              # Configuración auxiliar
│   ├── channels/        # Configuración de canales
│   ├── skills/          # Configuración de habilidades
│   └── providers/       # Configuración de proveedores
├── sessions/            # Historial de chat
├── logs/                # Archivos de registro
├── media/               # Archivos multimedia (imágenes, videos, etc.)
├── credentials/         # Tokens API, secretos
└── cache/               # Caché temporal
```

### ¿Puedo cambiar el directorio base?

Sí, establece `OPENCLAW_HOME`:

```bash
export OPENCLAW_HOME=/custom/path
openclaw send "hello"
```

O usa `--home`:

```bash
openclaw --home=/custom/path send "hello"
```

### ¿Dónde viven las credenciales?

Las credenciales se almacenan en:

```
~/.openclaw/credentials/
├── openai.json
├── anthropic.json
├── telegram.json
└── ...
```

Cada archivo es JSON con claves API y tokens.

**Nunca** cometas estos archivos en git o los compartas públicamente.

### ¿Dónde viven los archivos de registro?

Los registros se escriben en:

```
~/.openclaw/logs/
├── gateway.log          # Registro del gateway
├── agent.log            # Registro del agente
├── channels/            # Registros de canales
│   ├── telegram.log
│   ├── whatsapp.log
│   └── ...
└── sessions/            # Registros de sesiones
    ├── <session-id>.log
    └── ...
```

### ¿Cómo veo los registros?

```bash
# Registro del gateway
openclaw logs gateway

# Registro del agente
openclaw logs agent

# Registro de canal
openclaw logs channel telegram

# Registro de sesión
openclaw logs session <session-id>

# Seguir registros
openclaw logs gateway --follow
```

O lee los archivos directamente:

```bash
tail -f ~/.openclaw/logs/gateway.log
```

### ¿Dónde viven los archivos multimedia?

Los archivos multimedia (imágenes, videos, audio) se almacenan en:

```
~/.openclaw/media/
├── images/
├── videos/
├── audio/
└── documents/
```

Cada archivo se nombra por hash de contenido:

```
~/.openclaw/media/images/<sha256>.png
```

Esto evita duplicados y hace que los archivos sean direccionables por contenido.

---

## Conceptos básicos de configuración

### ¿Dónde está el archivo de configuración?

Por defecto, `~/.openclaw/config.toml`.

### ¿Cómo edito la configuración?

Opciones:

```bash
# Abrir en editor
openclaw config edit

# Establecer una clave
openclaw config set agent.model gpt-4

# Obtener una clave
openclaw config get agent.model

# Listar toda la configuración
openclaw config show
```

O edita `~/.openclaw/config.toml` directamente.

### ¿Cómo establezco mi clave API de OpenAI?

Opción 1 - Variable de entorno:

```bash
export OPENAI_API_KEY=sk-...
```

Opción 2 - Archivo de configuración:

```toml
[providers.openai]
api_key = "sk-..."
```

Opción 3 - Archivo de credenciales:

```bash
echo '{"api_key": "sk-..."}' > ~/.openclaw/credentials/openai.json
```

Opción 4 - CLI:

```bash
openclaw config set providers.openai.api_key sk-...
```

### ¿Cómo cambio el modelo predeterminado?

```bash
openclaw config set agent.model gpt-4
```

O en `config.toml`:

```toml
[agent]
model = "gpt-4"
```

### ¿Cómo establezco múltiples claves API?

Agrega múltiples proveedores:

```toml
[providers.openai]
api_key = "sk-..."

[providers.anthropic]
api_key = "sk-ant-..."

[providers.google]
api_key = "..."
```

O usa variables de entorno:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GOOGLE_API_KEY=...
```

OpenClaw detectará automáticamente y cargará todas las claves disponibles.

### ¿Cómo veo la configuración actual?

```bash
openclaw config show
```

Esto imprime toda la configuración en formato TOML.

### ¿Cómo restablezco la configuración a los valores predeterminados?

```bash
rm ~/.openclaw/config.toml
openclaw config init
```

Esto regenera un `config.toml` predeterminado.

---

## Gateways remotos y nodos

### ¿Qué es un gateway?

El gateway es el componente central que:

- Recibe mensajes de canales (WhatsApp, Telegram, etc.)
- Enruta mensajes a agentes
- Gestiona sesiones y contexto
- Maneja autenticación y control de acceso
- Proporciona una API para clientes

### ¿Puedo ejecutar el gateway remotamente?

Sí, ejecuta el gateway en un servidor y conéctate desde clientes:

**En el servidor:**

```bash
openclaw gateway run --bind 0.0.0.0 --port 8080
```

**En el cliente:**

```bash
openclaw config set gateway.url http://server-ip:8080
openclaw send "hello"
```

### ¿Cómo aseguro el gateway remoto?

Opciones:

1. **Autenticación de token:**

```toml
[gateway]
auth_token = "secret-token"
```

Los clientes deben proporcionar el token:

```bash
openclaw config set gateway.auth_token secret-token
```

2. **Túnel SSH:**

```bash
ssh -L 8080:localhost:8080 user@server
openclaw config set gateway.url http://localhost:8080
```

3. **VPN (Tailscale, WireGuard):**

Ejecuta el gateway en una red privada y conéctate vía VPN.

4. **Proxy inverso (nginx, Caddy):**

Proxy el gateway detrás de HTTPS con autenticación básica.

### ¿Qué es un nodo?

Un nodo es una instancia de OpenClaw que:

- Se conecta a un gateway remoto
- Ejecuta agentes localmente
- Proporciona recursos de cómputo (CPU, GPU, memoria)
- Puede ejecutar habilidades especializadas

Los nodos permiten distribución de carga de trabajo y computación especializada.

### ¿Cómo configuro un nodo?

**En el nodo:**

```toml
[node]
enabled = true
gateway_url = "http://gateway-server:8080"
auth_token = "secret-token"
```

Luego ejecuta:

```bash
openclaw node run
```

El nodo se registrará con el gateway y comenzará a aceptar trabajos.

### ¿Cómo listo los nodos conectados?

En el gateway:

```bash
openclaw nodes list
```

Esto muestra todos los nodos registrados y su estado.

### ¿Puedo ejecutar múltiples nodos?

Sí, ejecuta múltiples instancias de nodo, cada una conectada al mismo gateway:

```bash
# Nodo 1
openclaw node run --id node-1

# Nodo 2
openclaw node run --id node-2
```

El gateway equilibrará automáticamente la carga de trabajo entre los nodos.

---

## Variables de entorno y carga de .env

### ¿Lee OpenClaw archivos .env?

Sí, OpenClaw carga automáticamente archivos `.env` de:

- Directorio de trabajo actual (`.env`)
- Directorio de inicio (`~/.env`)
- Directorio de configuración (`~/.openclaw/.env`)

### ¿En qué orden se cargan los archivos .env?

1. Variables de entorno del sistema
2. `~/.openclaw/.env`
3. `~/.env`
4. `./.env` (directorio de trabajo actual)

Las fuentes posteriores sobrescriben las anteriores.

### ¿Puedo especificar un archivo .env personalizado?

Sí, usa `--env-file`:

```bash
openclaw --env-file=/path/to/.env send "hello"
```

O establece `OPENCLAW_ENV_FILE`:

```bash
export OPENCLAW_ENV_FILE=/path/to/.env
openclaw send "hello"
```

### ¿Qué variables de entorno soporta OpenClaw?

Variables comunes:

```bash
# Claves API
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...

# Configuración del gateway
OPENCLAW_GATEWAY_URL=http://localhost:8080
OPENCLAW_GATEWAY_AUTH_TOKEN=secret

# Configuración del agente
OPENCLAW_AGENT_MODEL=gpt-4
OPENCLAW_AGENT_TEMPERATURE=0.7

# Configuración de canales
TELEGRAM_BOT_TOKEN=...
DISCORD_BOT_TOKEN=...
WHATSAPP_SESSION_ID=...

# Configuración de sandbox
OPENCLAW_SANDBOX_ENABLED=true
OPENCLAW_SANDBOX_PROVIDER=docker

# Directorios
OPENCLAW_HOME=/custom/path
OPENCLAW_LOG_DIR=/custom/logs
```

### ¿Cómo veo qué variables se cargaron?

```bash
openclaw config env
```

Esto muestra todas las variables de entorno cargadas y sus fuentes.

---

## Sesiones y múltiples chats

### ¿Qué es una sesión?

Una sesión es una conversación única con el agente. Cada sesión tiene:

- ID de sesión único
- Historial de mensajes
- Contexto y estado
- Metadatos (canal, usuario, marca de tiempo)

### ¿Cómo inicio una nueva sesión?

Las sesiones se crean automáticamente cuando envías un mensaje:

```bash
openclaw send "hello"
```

Esto crea una nueva sesión y devuelve un ID de sesión.

### ¿Cómo reanudo una sesión?

Usa `--session`:

```bash
openclaw send --session=<session-id> "continuar conversación"
```

O almacena el ID de sesión y reutilízalo:

```bash
SESSION_ID=$(openclaw send "hello" --json | jq -r .session_id)
openclaw send --session=$SESSION_ID "continuar"
```

### ¿Cómo listo todas las sesiones?

```bash
openclaw sessions list
```

Esto muestra todas las sesiones con IDs, marcas de tiempo y resúmenes.

### ¿Cómo veo el historial de una sesión?

```bash
openclaw sessions show <session-id>
```

Esto imprime el historial completo de mensajes para la sesión.

### ¿Cómo elimino una sesión?

```bash
openclaw sessions delete <session-id>
```

Esto elimina el archivo de sesión y limpia los metadatos.

### ¿Puedo tener múltiples sesiones concurrentes?

Sí, cada sesión es independiente. Puedes ejecutar múltiples sesiones simultáneamente:

```bash
# Sesión 1
openclaw send --session=session-1 "hola" &

# Sesión 2
openclaw send --session=session-2 "hola" &
```

Las sesiones no interfieren entre sí.

---

## Modelos: predeterminados, selección, alias, cambio

### ¿Qué modelo usa OpenClaw por defecto?

Por defecto, OpenClaw usa el primer modelo disponible de los proveedores configurados.

Orden de prioridad:

1. `agent.model` en `config.toml`
2. `OPENCLAW_AGENT_MODEL` variable de entorno
3. Auto-detectado del primer proveedor configurado (OpenAI, Anthropic, etc.)

### ¿Cómo cambio el modelo predeterminado?

```bash
openclaw config set agent.model gpt-4
```

O en `config.toml`:

```toml
[agent]
model = "gpt-4"
```

### ¿Cómo uso un modelo diferente para un solo mensaje?

Usa `--model`:

```bash
openclaw send --model=claude-3-opus "hello"
```

Esto sobrescribe el modelo predeterminado solo para este mensaje.

### ¿Qué modelos están disponibles?

Listar todos los modelos:

```bash
openclaw models list
```

Esto muestra todos los modelos de todos los proveedores configurados.

### ¿Cómo creo un alias de modelo?

Los alias te permiten usar nombres cortos para modelos:

```toml
[agent.model_aliases]
fast = "gpt-3.5-turbo"
smart = "gpt-4"
cheap = "claude-3-haiku"
best = "claude-3-opus"
```

Luego usa:

```bash
openclaw send --model=fast "hello"
openclaw send --model=smart "resolver problema complejo"
```

### ¿Puedo cambiar de modelo a mitad de conversación?

Sí, usa `--model` con `--session`:

```bash
# Iniciar con gpt-3.5-turbo
SESSION_ID=$(openclaw send "hello" --model=gpt-3.5-turbo --json | jq -r .session_id)

# Cambiar a gpt-4
openclaw send --session=$SESSION_ID --model=gpt-4 "resolver problema complejo"

# Cambiar de nuevo a gpt-3.5-turbo
openclaw send --session=$SESSION_ID --model=gpt-3.5-turbo "seguimiento simple"
```

Cada mensaje puede usar un modelo diferente, el historial de la sesión se conserva.

### ¿Cómo especifico parámetros del modelo?

Usa opciones de CLI:

```bash
openclaw send --model=gpt-4 --temperature=0.9 --max-tokens=1000 "mensaje"
```

O configura valores predeterminados:

```toml
[agent]
model = "gpt-4"
temperature = 0.7
max_tokens = 2000
top_p = 0.9
```

### ¿Qué modelos son los más rápidos?

Generalmente:

- **Más rápido:** `gpt-3.5-turbo`, `claude-3-haiku`, `gemini-1.5-flash`
- **Equilibrado:** `gpt-4`, `claude-3-sonnet`, `gemini-1.5-pro`
- **Mejor calidad:** `gpt-4-turbo`, `claude-3-opus`, `gemini-1.5-pro`

Los modelos más rápidos son buenos para:

- Tareas simples
- Respuestas rápidas
- Alto volumen
- Menor costo

Los modelos más lentos/mejores son buenos para:

- Razonamiento complejo
- Edición de código
- Análisis profundo
- Máxima calidad

---

## Failover de modelos

### ¿Qué es el failover de modelos?

El failover de modelos cambia automáticamente a un modelo de respaldo si el modelo principal falla.

Útil para:

- Límites de tasa API
- Interrupciones del proveedor
- Problemas de red
- Superación de cuota

### ¿Cómo configuro el failover?

```toml
[agent]
model = "gpt-4"
fallback_models = ["gpt-3.5-turbo", "claude-3-sonnet"]
```

Si `gpt-4` falla, OpenClaw probará `gpt-3.5-turbo`, luego `claude-3-sonnet`.

### ¿Puedo hacer failover entre proveedores?

Sí, especifica modelos de diferentes proveedores:

```toml
[agent]
model = "gpt-4"
fallback_models = ["claude-3-sonnet", "gemini-1.5-pro"]
```

Esto hace failover de OpenAI → Anthropic → Google.

### ¿Cómo veo qué modelo se usó?

La respuesta incluye el modelo usado:

```bash
openclaw send "hello" --json | jq .model
```

O verifica los registros:

```bash
openclaw logs agent | grep "model="
```

### ¿Cuántas veces reintenta el failover?

Por defecto, OpenClaw prueba todos los modelos de failover una vez.

Personaliza el comportamiento de reintento:

```toml
[agent.failover]
max_retries = 3
retry_delay = 5  # segundos
```

---

## Perfiles de autenticación

### ¿Qué son los perfiles de autenticación?

Los perfiles de autenticación te permiten gestionar múltiples conjuntos de credenciales para el mismo proveedor.

Útil para:

- Múltiples cuentas de OpenAI
- Diferentes organizaciones
- Entornos de desarrollo/staging/producción
- Diferentes límites de tasa

### ¿Cómo creo un perfil?

```toml
[providers.openai]
api_key = "sk-default-key"

[providers.openai.profiles.work]
api_key = "sk-work-key"
organization = "org-work"

[providers.openai.profiles.personal]
api_key = "sk-personal-key"
organization = "org-personal"
```

### ¿Cómo uso un perfil?

Usa `--profile`:

```bash
openclaw send --profile=work "mensaje de trabajo"
openclaw send --profile=personal "mensaje personal"
```

O establece el perfil predeterminado:

```toml
[agent]
profile = "work"
```

### ¿Puedo cambiar de perfil por sesión?

Sí, especifica el perfil al iniciar la sesión:

```bash
SESSION_ID=$(openclaw send --profile=work "hello" --json | jq -r .session_id)
openclaw send --session=$SESSION_ID --profile=work "continuar"
```

Los perfiles son por mensaje, no por sesión.

### ¿Cómo listo todos los perfiles?

```bash
openclaw config profiles list
```

Esto muestra todos los perfiles configurados y sus proveedores.

---

## Puertos del gateway y modo remoto

### ¿En qué puerto se ejecuta el gateway?

Puerto predeterminado: `8080`

Personaliza con:

```bash
openclaw gateway run --port=9000
```

O en `config.toml`:

```toml
[gateway]
port = 9000
```

### ¿Cómo verifico si el gateway se está ejecutando?

```bash
openclaw gateway status
```

O verifica el puerto:

```bash
curl http://localhost:8080/health
```

### ¿Puedo ejecutar múltiples gateways?

Sí, usa puertos diferentes:

```bash
# Gateway 1
openclaw gateway run --port=8080 --id=gateway-1

# Gateway 2
openclaw gateway run --port=8081 --id=gateway-2
```

Luego configura los clientes para conectarse a gateways específicos:

```bash
openclaw send --gateway-url=http://localhost:8080 "mensaje"
openclaw send --gateway-url=http://localhost:8081 "mensaje"
```

### ¿Cómo configuro el modo remoto?

**En el servidor (ejecutar el gateway):**

```bash
openclaw gateway run --bind=0.0.0.0 --port=8080
```

**En el cliente (conectar al gateway):**

```bash
openclaw config set gateway.url http://server-ip:8080
openclaw send "hello"
```

### ¿Cómo aseguro un gateway remoto?

Ver [¿Cómo aseguro el gateway remoto?](#cómo-aseguro-el-gateway-remoto)

### ¿Qué es el modo local?

El modo local ejecuta el gateway y el agente en el mismo proceso (sin servidor separado).

Útil para:

- Desarrollo local
- Máquinas de un solo usuario
- Herramientas de línea de comandos
- Scripts

Habilitar modo local:

```toml
[gateway]
mode = "local"
```

### ¿Qué es el modo remoto?

El modo remoto ejecuta el gateway como un servidor separado, los clientes se conectan vía HTTP.

Útil para:

- Múltiples usuarios
- Recursos compartidos
- Gestión centralizada
- Escalado

Habilitar modo remoto:

```toml
[gateway]
mode = "remote"
url = "http://gateway-server:8080"
```

---

## Registro y depuración

### ¿Cómo habilito el registro detallado?

Usa `--verbose` o `-v`:

```bash
openclaw send -v "hello"
```

O establece el nivel de registro:

```bash
openclaw config set logging.level debug
```

Niveles de registro: `error`, `warn`, `info`, `debug`, `trace`

### ¿Cómo veo los registros del gateway?

```bash
openclaw logs gateway
```

O lee el archivo directamente:

```bash
tail -f ~/.openclaw/logs/gateway.log
```

### ¿Cómo veo los registros del agente?

```bash
openclaw logs agent
```

O:

```bash
tail -f ~/.openclaw/logs/agent.log
```

### ¿Cómo veo los registros de canales?

```bash
openclaw logs channel telegram
```

O:

```bash
tail -f ~/.openclaw/logs/channels/telegram.log
```

### ¿Cómo depuro problemas de sesión?

1. Ver historial de sesión:

```bash
openclaw sessions show <session-id>
```

2. Ver registros de sesión:

```bash
openclaw logs session <session-id>
```

3. Verificar archivo de sesión:

```bash
cat ~/.openclaw/sessions/<session-id>.jsonl
```

### ¿Cómo depuro problemas de conexión?

1. Verificar estado del gateway:

```bash
openclaw gateway status
```

2. Probar conectividad:

```bash
curl http://localhost:8080/health
```

3. Verificar configuración:

```bash
openclaw config show | grep gateway
```

4. Ver registros del gateway:

```bash
openclaw logs gateway --follow
```

### ¿Cómo depuro llamadas API?

Habilitar registro de solicitudes HTTP:

```toml
[logging]
level = "debug"
http_requests = true
```

Esto registra todas las solicitudes/respuestas de API.

### ¿Cómo exporto registros?

```bash
# Exportar todos los registros
tar -czf logs-$(date +%Y%m%d).tar.gz ~/.openclaw/logs/

# Exportar registros específicos
openclaw logs gateway --since=1h > gateway-last-hour.log
```

---

## Multimedia y adjuntos

### ¿Soporta OpenClaw imágenes?

Sí, envía imágenes usando:

```bash
openclaw send --image=/path/to/image.png "¿qué es esto?"
```

O desde canales de mensajería:

- WhatsApp: envía imagen + caption
- Telegram: envía foto + caption
- Discord: adjunta imagen + mensaje

### ¿Qué formatos de imagen se soportan?

Formatos comunes:

- PNG
- JPEG/JPG
- GIF
- WebP
- SVG

El soporte depende del modelo LLM:

- GPT-4 Vision: PNG, JPEG, GIF, WebP
- Claude 3: PNG, JPEG, GIF, WebP
- Gemini: PNG, JPEG, GIF, WebP, SVG

### ¿Soporta OpenClaw video?

Sí, algunos modelos soportan entrada de video:

```bash
openclaw send --video=/path/to/video.mp4 "resumir este video"
```

Los modelos con soporte de video:

- Gemini 1.5 Pro
- GPT-4 Vision (soporte limitado)

### ¿Soporta OpenClaw audio?

Sí, para transcripción:

```bash
openclaw send --audio=/path/to/audio.mp3 "transcribir"
```

O usa el comando de transcripción dedicado:

```bash
openclaw transcribe /path/to/audio.mp3
```

### ¿Cómo envío múltiples adjuntos?

```bash
openclaw send --image=img1.png --image=img2.png --file=doc.pdf "analizar estos"
```

O usa archivos múltiples:

```bash
openclaw send --files img1.png,img2.png,doc.pdf "analizar"
```

### ¿Dónde se almacenan los adjuntos?

Los archivos multimedia se almacenan en:

```
~/.openclaw/media/
├── images/
├── videos/
├── audio/
└── documents/
```

Los archivos se nombran por hash de contenido (SHA-256).

### ¿Cómo listo todos los archivos multimedia?

```bash
openclaw media list
```

Esto muestra todos los archivos multimedia con tamaños y marcas de tiempo.

### ¿Cómo limpio archivos multimedia antiguos?

```bash
# Eliminar más antiguos que 30 días
openclaw media clean --older-than=30d

# Eliminar por tamaño
openclaw media clean --larger-than=10M

# Limpiar todo
openclaw media clean --all
```

---

## Seguridad y control de acceso

### ¿Cómo aseguro mi instancia de OpenClaw?

Mejores prácticas:

1. **Usa autenticación de token:**

```toml
[gateway]
auth_token = "strong-random-token"
```

2. **Ejecuta en una red privada:**

Use VPN (Tailscale, WireGuard) o túnel SSH.

3. **Habilita HTTPS:**

Usa un proxy inverso (nginx, Caddy) con certificados SSL.

4. **Limita el enlace:**

```bash
openclaw gateway run --bind=127.0.0.1  # solo local
```

5. **Habilita sandboxing:**

```toml
[agent.sandbox]
enabled = true
```

6. **Limita el acceso a archivos:**

```toml
[agent.filesystem]
allowed_paths = ["/safe/dir"]
denied_paths = ["/etc", "/root"]
```

7. **Deshabilita comandos peligrosos:**

```toml
[agent.commands]
blacklist = ["rm -rf", "dd", "mkfs"]
```

### ¿Cómo controlo quién puede usar el agente?

Usa listas de permitidos de usuarios:

```toml
[gateway.access]
allowed_users = [
  "alice@example.com",
  "bob@example.com"
]
```

O listas de permitidos de canales:

```toml
[gateway.access]
allowed_channels = ["telegram", "discord"]
allowed_telegram_users = [123456, 789012]
allowed_discord_users = [987654321]
```

### ¿Puedo limitar qué comandos puede ejecutar el agente?

Sí, usa listas negras/blancas de comandos:

```toml
[agent.commands]
# Solo permitir estos comandos
whitelist = ["ls", "cat", "grep", "find"]

# O bloquear comandos específicos
blacklist = ["rm -rf", "dd", "mkfs", "sudo"]
```

### ¿Puedo limitar el acceso a archivos?

Sí:

```toml
[agent.filesystem]
# Solo permitir acceso a estos directorios
allowed_paths = ["/home/user/projects", "/tmp"]

# Negar acceso a estos directorios
denied_paths = ["/etc", "/root", "/home/user/.ssh"]
```

### ¿Puedo auditar las acciones del agente?

Sí, habilita el registro de auditoría:

```toml
[logging]
audit = true
audit_file = "~/.openclaw/logs/audit.log"
```

Esto registra todas las acciones del agente:

- Comandos ejecutados
- Archivos leídos/escritos
- Llamadas API
- Acceso a sesión

### ¿Cómo veo los registros de auditoría?

```bash
openclaw logs audit
```

O:

```bash
tail -f ~/.openclaw/logs/audit.log
```

---

## Comandos de chat y abortar tareas

### ¿Cómo aborto una tarea en ejecución?

Desde CLI:

```bash
# Presiona Ctrl+C para abortar
```

Desde canales de mensajería, envía:

```
/abort
```

O:

```
/cancel
```

O:

```
/stop
```

### ¿Puedo pausar y reanudar tareas?

Sí, usa:

```
/pause
```

Para reanudar:

```
/resume
```

### ¿Cómo veo el estado de la tarea?

```
/status
```

Esto muestra:

- Tarea actual
- Progreso
- Tiempo transcurrido
- Recursos utilizados

### ¿Qué comandos de chat se soportan?

Comandos comunes:

- `/help` - Mostrar ayuda
- `/status` - Mostrar estado de tarea
- `/abort` - Abortar tarea actual
- `/pause` - Pausar tarea
- `/resume` - Reanudar tarea
- `/history` - Mostrar historial de sesión
- `/clear` - Limpiar historial de sesión
- `/model <nombre>` - Cambiar modelo
- `/settings` - Mostrar configuración
- `/reset` - Restablecer sesión

### ¿Puedo crear comandos personalizados?

Sí, agrega comandos personalizados en `config.toml`:

```toml
[[agent.commands]]
name = "deploy"
description = "Desplegar aplicación"
script = "scripts/deploy.sh"

[[agent.commands]]
name = "test"
description = "Ejecutar tests"
script = "scripts/test.sh"
```

Luego usa:

```
/deploy
/test
```

### ¿Cómo desactivo comandos?

```toml
[agent]
commands_enabled = false
```

O desactiva comandos específicos:

```toml
[agent.commands]
disabled = ["abort", "reset"]
```

---

## Fin

¿Todavía tienes preguntas? Consulta:

- [Solución de problemas](/es-ES/help/troubleshooting) - Problemas y soluciones comunes
- [Depuración](/es-ES/help/debugging) - Herramientas y flujos de trabajo de depuración
- [Pruebas](/es-ES/help/testing) - Suites y directrices de pruebas
- [Variables de entorno](/es-ES/help/environment) - Referencia de variables de entorno
- [Scripts](/es-ES/help/scripts) - Documentación de scripts del repositorio

O abre un issue: https://github.com/openclaw/openclaw/issues
