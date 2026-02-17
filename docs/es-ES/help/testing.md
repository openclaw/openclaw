---
summary: "Kit de pruebas: suites de unidad/e2e/en vivo, ejecutores Docker y qué cubre cada prueba"
read_when:
  - Ejecutando pruebas localmente o en CI
  - Agregando regresiones para errores de modelo/proveedor
  - Depurando comportamiento de gateway + agente
title: "Pruebas"
---

# Pruebas

OpenClaw tiene tres suites Vitest (unidad/integración, e2e, en vivo) y un pequeño conjunto de ejecutores Docker.

Este documento es una guía de "cómo probamos":

- Qué cubre cada suite (y qué deliberadamente _no_ cubre)
- Qué comandos ejecutar para flujos de trabajo comunes (local, pre-push, depuración)
- Cómo las pruebas en vivo descubren credenciales y seleccionan modelos/proveedores
- Cómo agregar regresiones para problemas reales de modelo/proveedor

## Inicio rápido

La mayoría de los días:

- Compuerta completa (esperado antes de push): `pnpm build && pnpm check && pnpm test`

Cuando tocas pruebas o quieres confianza extra:

- Compuerta de cobertura: `pnpm test:coverage`
- Suite E2E: `pnpm test:e2e`

Cuando depuras proveedores/modelos reales (requiere credenciales reales):

- Suite en vivo (modelos + sondas de herramientas/imagen del gateway): `pnpm test:live`

Consejo: cuando solo necesitas un caso fallido, prefiere reducir las pruebas en vivo vía las variables de entorno de lista de permitidos descritas abajo.

## Suites de prueba (qué se ejecuta dónde)

Piensa en las suites como "realismo creciente" (e inestabilidad/costo creciente):

### Unidad / integración (por defecto)

- Comando: `pnpm test`
- Config: `scripts/test-parallel.mjs` (ejecuta `vitest.unit.config.ts`, `vitest.extensions.config.ts`, `vitest.gateway.config.ts`)
- Archivos: `src/**/*.test.ts`, `extensions/**/*.test.ts`
- Alcance:
  - Pruebas de unidad puras
  - Pruebas de integración en proceso (autenticación de gateway, enrutamiento, herramientas, análisis, configuración)
  - Regresiones deterministas para errores conocidos
- Expectativas:
  - Se ejecuta en CI
  - No se requieren claves reales
  - Debe ser rápido y estable
- Nota de pool:
  - OpenClaw usa Vitest `vmForks` en Node 22/23 para fragmentos de unidad más rápidos.
  - En Node 24+, OpenClaw automáticamente vuelve a `forks` regulares para evitar errores de enlace VM de Node (`ERR_VM_MODULE_LINK_FAILURE` / `module is already linked`).
  - Sobrescribe manualmente con `OPENCLAW_TEST_VM_FORKS=0` (forzar `forks`) o `OPENCLAW_TEST_VM_FORKS=1` (forzar `vmForks`).

### E2E (smoke del gateway)

- Comando: `pnpm test:e2e`
- Config: `vitest.e2e.config.ts`
- Archivos: `src/**/*.e2e.test.ts`
- Valores por defecto en tiempo de ejecución:
  - Usa Vitest `vmForks` para inicio de archivo más rápido.
  - Usa workers adaptativos (CI: 2-4, local: 4-8).
  - Se ejecuta en modo silencioso por defecto para reducir sobrecarga de I/O de consola.
- Sobrescrituras útiles:
  - `OPENCLAW_E2E_WORKERS=<n>` para forzar cuenta de workers (limitado a 16).
  - `OPENCLAW_E2E_VERBOSE=1` para reactivar salida de consola verbosa.
- Alcance:
  - Comportamiento de extremo a extremo de gateway multi-instancia
  - Superficies WebSocket/HTTP, emparejamiento de nodos y redes más pesadas
- Expectativas:
  - Se ejecuta en CI (cuando está habilitado en el pipeline)
  - No se requieren claves reales
  - Más partes móviles que pruebas unitarias (puede ser más lento)

### En vivo (proveedores reales + modelos reales)

- Comando: `pnpm test:live`
- Config: `vitest.live.config.ts`
- Archivos: `src/**/*.live.test.ts`
- Por defecto: **habilitado** por `pnpm test:live` (establece `OPENCLAW_LIVE_TEST=1`)
- Alcance:
  - "¿Este proveedor/modelo realmente funciona _hoy_ con credenciales reales?"
  - Capturar cambios de formato de proveedor, peculiaridades de llamadas a herramientas, problemas de autenticación y comportamiento de límite de tasa
- Expectativas:
  - No estable en CI por diseño (redes reales, políticas reales de proveedor, cuotas, interrupciones)
  - Cuesta dinero / usa límites de tasa
  - Prefiere ejecutar subconjuntos reducidos en lugar de "todo"
  - Las ejecuciones en vivo obtendrán `~/.profile` para obtener claves de API faltantes
  - Rotación de clave de Anthropic: establece `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (o `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) o múltiples variables `ANTHROPIC_API_KEY*`; las pruebas reintentarán en límites de tasa

## ¿Qué suite debo ejecutar?

Usa esta tabla de decisiones:

- Editando lógica/pruebas: ejecuta `pnpm test` (y `pnpm test:coverage` si cambiaste mucho)
- Tocando redes del gateway / protocolo WS / emparejamiento: agrega `pnpm test:e2e`
- Depurando "mi bot está caído" / fallas específicas del proveedor / llamadas a herramientas: ejecuta un `pnpm test:live` reducido

## En vivo: smoke de modelo (claves de perfil)

Las pruebas en vivo se dividen en dos capas para que podamos aislar fallas:

- "Modelo directo" nos dice que el proveedor/modelo puede responder en absoluto con la clave dada.
- "Smoke del Gateway" nos dice que el pipeline completo gateway+agente funciona para ese modelo (sesiones, historial, herramientas, política de sandbox, etc.).

### Capa 1: Completado de modelo directo (sin gateway)

- Prueba: `src/agents/models.profiles.live.test.ts`
- Objetivo:
  - Enumerar modelos descubiertos
  - Usar `getApiKeyForModel` para seleccionar modelos para los que tienes credenciales
  - Ejecutar un pequeño completado por modelo (y regresiones dirigidas donde sea necesario)
- Cómo habilitar:
  - `pnpm test:live` (o `OPENCLAW_LIVE_TEST=1` si invocas Vitest directamente)
- Establece `OPENCLAW_LIVE_MODELS=modern` (o `all`, alias para modern) para realmente ejecutar esta suite; de lo contrario se omite para mantener `pnpm test:live` enfocado en smoke del gateway
- Cómo seleccionar modelos:
  - `OPENCLAW_LIVE_MODELS=modern` para ejecutar la lista de permitidos moderna (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` es un alias para la lista de permitidos moderna
  - o `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (lista de permitidos separada por comas)
- Cómo seleccionar proveedores:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (lista de permitidos separada por comas)
- De dónde vienen las claves:
  - Por defecto: almacén de perfiles y respaldos de env
  - Establece `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` para forzar **solo almacén de perfiles**
- Por qué existe esto:
  - Separa "la API del proveedor está rota / la clave es inválida" de "el pipeline del agente del gateway está roto"
  - Contiene regresiones pequeñas y aisladas (ejemplo: OpenAI Responses/Codex Responses reproducción de razonamiento + flujos de llamadas a herramientas)

### Capa 2: Smoke del Gateway + agente dev (qué hace "@openclaw" realmente)

- Prueba: `src/gateway/gateway-models.profiles.live.test.ts`
- Objetivo:
  - Activar un gateway en proceso
  - Crear/parchear una sesión `agent:dev:*` (sobrescritura de modelo por ejecución)
  - Iterar modelos-con-claves y afirmar:
    - Respuesta "significativa" (sin herramientas)
    - una invocación de herramienta real funciona (sonda de lectura)
    - sondas de herramientas extra opcionales (sonda exec+read)
    - rutas de regresión de OpenAI (solo llamada-a-herramienta → seguimiento) siguen funcionando
- Detalles de sonda (para que puedas explicar fallas rápidamente):
  - Sonda `read`: la prueba escribe un archivo nonce en el workspace y le pide al agente que lo `read` y devuelva el nonce.
  - Sonda `exec+read`: la prueba le pide al agente que `exec`-escriba un nonce en un archivo temporal, luego que lo `read` de vuelta.
  - Sonda de imagen: la prueba adjunta un PNG generado (gato + código aleatorizado) y espera que el modelo devuelva `cat <CODE>`.
  - Referencia de implementación: `src/gateway/gateway-models.profiles.live.test.ts` y `src/gateway/live-image-probe.ts`.
- Cómo habilitar:
  - `pnpm test:live` (o `OPENCLAW_LIVE_TEST=1` si invocas Vitest directamente)
- Cómo seleccionar modelos:
  - Por defecto: lista de permitidos moderna (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` es un alias para la lista de permitidos moderna
  - O establece `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (o lista separada por comas) para reducir
- Cómo seleccionar proveedores (evitar "OpenRouter todo"):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (lista de permitidos separada por comas)
- Las sondas de herramienta + imagen siempre están activas en esta prueba en vivo:
  - Sonda `read` + sonda `exec+read` (estrés de herramienta)
  - la sonda de imagen se ejecuta cuando el modelo anuncia soporte de entrada de imagen
  - Flujo (alto nivel):
    - La prueba genera un pequeño PNG con "CAT" + código aleatorio (`src/gateway/live-image-probe.ts`)
    - Lo envía vía `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - El Gateway analiza archivos adjuntos en `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - El agente integrado reenvía un mensaje de usuario multimodal al modelo
    - Aserción: la respuesta contiene `cat` + el código (tolerancia OCR: errores menores permitidos)

Consejo: para ver qué puedes probar en tu máquina (y los ids exactos de `provider/model`), ejecuta:

```bash
openclaw models list
openclaw models list --json
```

## En vivo: smoke de setup-token de Anthropic

- Prueba: `src/agents/anthropic.setup-token.live.test.ts`
- Objetivo: verificar que el setup-token del Claude Code CLI (o un perfil de setup-token pegado) puede completar un prompt de Anthropic.
- Habilitar:
  - `pnpm test:live` (o `OPENCLAW_LIVE_TEST=1` si invocas Vitest directamente)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Fuentes de token (elige una):
  - Perfil: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Token en bruto: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Sobrescritura de modelo (opcional):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Ejemplo de configuración:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## En vivo: smoke de backend CLI (Claude Code CLI u otros CLIs locales)

- Prueba: `src/gateway/gateway-cli-backend.live.test.ts`
- Objetivo: validar el pipeline Gateway + agente usando un backend CLI local, sin tocar tu configuración por defecto.
- Habilitar:
  - `pnpm test:live` (o `OPENCLAW_LIVE_TEST=1` si invocas Vitest directamente)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Valores por defecto:
  - Modelo: `claude-cli/claude-sonnet-4-5`
  - Comando: `claude`
  - Args: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Sobrescrituras (opcional):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` para enviar un archivo adjunto de imagen real (las rutas se inyectan en el prompt).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` para pasar rutas de archivos de imagen como args CLI en lugar de inyección de prompt.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (o `"list"`) para controlar cómo se pasan los args de imagen cuando se establece `IMAGE_ARG`.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` para enviar un segundo turno y validar el flujo de reanudación.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` para mantener la configuración MCP del Claude Code CLI habilitada (por defecto deshabilita la configuración MCP con un archivo vacío temporal).

Ejemplo:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Recetas en vivo recomendadas

Las listas de permitidos estrechas y explícitas son las más rápidas y menos inestables:

- Modelo único, directo (sin gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Modelo único, smoke del gateway:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Llamadas a herramientas en varios proveedores:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Enfoque en Google (clave de API de Gemini + Antigravity):
  - Gemini (clave de API): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Notas:

- `google/...` usa la API de Gemini (clave de API).
- `google-antigravity/...` usa el puente OAuth de Antigravity (endpoint de agente estilo Cloud Code Assist).
- `google-gemini-cli/...` usa el CLI de Gemini local en tu máquina (autenticación separada + peculiaridades de herramientas).
- API de Gemini vs CLI de Gemini:
  - API: OpenClaw llama a la API de Gemini alojada de Google sobre HTTP (clave de API / autenticación de perfil); esto es lo que la mayoría de los usuarios quieren decir con "Gemini".
  - CLI: OpenClaw ejecuta un binario `gemini` local; tiene su propia autenticación y puede comportarse diferente (streaming/soporte de herramientas/desvío de versión).

## Credenciales (nunca hacer commit)

Las pruebas en vivo descubren credenciales de la misma manera que lo hace el CLI. Implicaciones prácticas:

- Si el CLI funciona, las pruebas en vivo deberían encontrar las mismas claves.
- Si una prueba en vivo dice "sin credenciales", depura de la misma manera que depurarías `openclaw models list` / selección de modelo.

- Almacén de perfiles: `~/.openclaw/credentials/` (preferido; lo que significa "claves de perfil" en las pruebas)
- Config: `~/.openclaw/openclaw.json` (o `OPENCLAW_CONFIG_PATH`)

Si quieres confiar en claves de env (ej. exportadas en tu `~/.profile`), ejecuta pruebas locales después de `source ~/.profile`, o usa los ejecutores Docker abajo (pueden montar `~/.profile` en el contenedor).

## Deepgram en vivo (transcripción de audio)

- Prueba: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Habilitar: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Ejecutores Docker (verificaciones opcionales de "funciona en Linux")

Estos ejecutan `pnpm test:live` dentro de la imagen Docker del repo, montando tu directorio de configuración local y workspace (y obteniendo `~/.profile` si está montado):

- Modelos directos: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- Gateway + agente dev: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Asistente de incorporación (TTY, andamiaje completo): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Redes del Gateway (dos contenedores, autenticación WS + salud): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)
- Plugins (carga de extensión personalizada + smoke de registro): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)

Variables de entorno útiles:

- `OPENCLAW_CONFIG_DIR=...` (por defecto: `~/.openclaw`) montado en `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (por defecto: `~/.openclaw/workspace`) montado en `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (por defecto: `~/.profile`) montado en `/home/node/.profile` y obtenido antes de ejecutar pruebas
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` para reducir la ejecución
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` para asegurar que las credenciales vienen del almacén de perfiles (no env)

## Verificación de documentos

Ejecuta verificaciones de documentos después de ediciones de documentos: `pnpm docs:list`.

## Regresión fuera de línea (segura para CI)

Estas son regresiones de "pipeline real" sin proveedores reales:

- Llamadas a herramientas del Gateway (OpenAI simulado, bucle real gateway + agente): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Asistente del Gateway (WS `wizard.start`/`wizard.next`, escrituras de config + autenticación forzada): `src/gateway/gateway.wizard.e2e.test.ts`

## Evaluaciones de confiabilidad del agente (habilidades)

Ya tenemos algunas pruebas seguras para CI que se comportan como "evaluaciones de confiabilidad del agente":

- Llamadas a herramientas simuladas a través del bucle real gateway + agente (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- Flujos de asistente de extremo a extremo que validan cableado de sesión y efectos de configuración (`src/gateway/gateway.wizard.e2e.test.ts`).

Lo que aún falta para habilidades (ver [Habilidades](/es-ES/tools/skills)):

- **Toma de decisiones:** cuando las habilidades se listan en el prompt, ¿el agente elige la habilidad correcta (o evita las irrelevantes)?
- **Cumplimiento:** ¿el agente lee `SKILL.md` antes de usar y sigue los pasos/args requeridos?
- **Contratos de flujo de trabajo:** escenarios de múltiples turnos que afirman orden de herramientas, transferencia de historial de sesión y límites de sandbox.

Las evaluaciones futuras deben mantenerse deterministas primero:

- Un ejecutor de escenarios usando proveedores simulados para afirmar llamadas a herramientas + orden, lecturas de archivos de habilidad y cableado de sesión.
- Una pequeña suite de escenarios enfocados en habilidades (usar vs evitar, bloqueo, inyección de prompt).
- Evaluaciones en vivo opcionales (opt-in, cerradas por env) solo después de que la suite segura para CI esté en su lugar.

## Agregar regresiones (guía)

Cuando corriges un problema de proveedor/modelo descubierto en vivo:

- Agrega una regresión segura para CI si es posible (proveedor simulado/stub, o captura la transformación de forma de solicitud exacta)
- Si es inherentemente solo en vivo (límites de tasa, políticas de autenticación), mantén la prueba en vivo reducida y opt-in vía variables de env
- Prefiere apuntar a la capa más pequeña que capture el error:
  - error de conversión/reproducción de solicitud del proveedor → prueba de modelos directos
  - error de pipeline de sesión/historial/herramienta del gateway → smoke en vivo del gateway o prueba simulada del gateway segura para CI
