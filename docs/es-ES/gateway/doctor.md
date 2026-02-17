---
summary: "Comando Doctor: verificaciones de salud, migraciones de configuración y pasos de reparación"
read_when:
  - Agregando o modificando migraciones del doctor
  - Introduciendo cambios de configuración disruptivos
title: "Doctor"
---

# Doctor

`openclaw doctor` es la herramienta de reparación + migración para OpenClaw. Arregla
config/estado obsoleto, verifica salud, y proporciona pasos de reparación accionables.

## Inicio rápido

```bash
openclaw doctor
```

### Sin interfaz / automatización

```bash
openclaw doctor --yes
```

Acepta valores predeterminados sin preguntar (incluyendo pasos de reparación restart/service/sandbox cuando sea aplicable).

```bash
openclaw doctor --repair
```

Aplica reparaciones recomendadas sin preguntar (reparaciones + reinicios donde sea seguro).

```bash
openclaw doctor --repair --force
```

Aplica también reparaciones agresivas (sobrescribe configuraciones de supervisor personalizadas).

```bash
openclaw doctor --non-interactive
```

Ejecuta sin prompts y solo aplica migraciones seguras (normalización de config + movimientos de estado en disco). Omite acciones restart/service/sandbox que requieren confirmación humana.
Las migraciones de estado heredado se ejecutan automáticamente cuando se detectan.

```bash
openclaw doctor --deep
```

Escanea servicios del sistema para instalaciones extra del gateway (launchd/systemd/schtasks).

Si quieres revisar cambios antes de escribir, abre el archivo de configuración primero:

```bash
cat ~/.openclaw/openclaw.json
```

## Qué hace (resumen)

- Actualización pre-vuelo opcional para instalaciones git (solo interactivo).
- Verificación de frescura del protocolo UI (reconstruye Control UI cuando el esquema del protocolo es más nuevo).
- Verificación de salud + prompt de reinicio.
- Resumen de estado de habilidades (elegibles/faltantes/bloqueadas).
- Normalización de configuración para valores heredados.
- Advertencias de anulación de proveedor OpenCode Zen (`models.providers.opencode`).
- Migración de estado heredado en disco (sesiones/directorio de agente/auth de WhatsApp).
- Verificaciones de integridad y permisos de estado (sesiones, transcripciones, directorio de estado).
- Verificaciones de permisos de archivo de configuración (chmod 600) cuando se ejecuta localmente.
- Salud de auth del modelo: verifica expiración de OAuth, puede refrescar tokens que expiran, y reporta estados de cooldown/deshabilitado del perfil de auth.
- Detección extra de directorio de workspace (`~/openclaw`).
- Reparación de imagen de sandbox cuando el sandboxing está habilitado.
- Migración de servicio heredado y detección extra del gateway.
- Verificaciones de runtime del gateway (servicio instalado pero no ejecutándose; etiqueta launchd en caché).
- Advertencias de estado de canales (probado desde el gateway en ejecución).
- Auditoría de configuración de supervisor (launchd/systemd/schtasks) con reparación opcional.
- Verificaciones de mejores prácticas de runtime del gateway (Node vs Bun, rutas de version-manager).
- Diagnósticos de colisión de puerto del gateway (predeterminado `18789`).
- Advertencias de seguridad para políticas de DM abierto.
- Advertencias de auth del gateway cuando no hay `gateway.auth.token` establecido (modo local; ofrece generación de token).
- Verificación de linger de systemd en Linux.
- Verificaciones de instalación desde fuente (desajuste de workspace pnpm, activos UI faltantes, binario tsx faltante).
- Escribe configuración actualizada + metadatos del wizard.

## Comportamiento detallado y justificación

### 0) Actualización opcional (instalaciones git)

Si esta es un checkout de git y doctor se ejecuta interactivamente, ofrece
actualizar (fetch/rebase/build) antes de ejecutar doctor.

### 1) Normalización de configuración

Si la configuración contiene formas de valor heredadas (por ejemplo `messages.ackReaction`
sin una anulación específica de canal), doctor las normaliza en el esquema actual.

### 2) Migraciones de claves de configuración heredadas

Cuando la configuración contiene claves obsoletas, otros comandos se niegan a ejecutar y piden
que ejecutes `openclaw doctor`.

Doctor:

- Explicará qué claves heredadas se encontraron.
- Mostrará la migración que aplicó.
- Reescribirá `~/.openclaw/openclaw.json` con el esquema actualizado.

El Gateway también auto-ejecuta migraciones de doctor al inicio cuando detecta un
formato de configuración heredado, así que las configuraciones obsoletas se reparan sin intervención manual.

Migraciones actuales:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → `bindings` de nivel superior
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) Anulaciones de proveedor OpenCode Zen

Si has agregado `models.providers.opencode` (o `opencode-zen`) manualmente, 
anula el catálogo integrado de OpenCode Zen de `@mariozechner/pi-ai`. Eso puede
forzar cada modelo a una sola API o poner los costos a cero. Doctor advierte para que puedas
eliminar la anulación y restaurar el enrutamiento de API por modelo + costos.

### 3) Migraciones de estado heredado (diseño de disco)

Doctor puede migrar diseños más antiguos en disco a la estructura actual:

- Almacén de sesiones + transcripciones:
  - de `~/.openclaw/sessions/` a `~/.openclaw/agents/<agentId>/sessions/`
- Directorio de agente:
  - de `~/.openclaw/agent/` a `~/.openclaw/agents/<agentId>/agent/`
- Estado de auth de WhatsApp (Baileys):
  - de heredado `~/.openclaw/credentials/*.json` (excepto `oauth.json`)
  - a `~/.openclaw/credentials/whatsapp/<accountId>/...` (id de cuenta predeterminado: `default`)

Estas migraciones son de mejor esfuerzo e idempotentes; doctor emitirá advertencias cuando
deje carpetas heredadas como respaldos. El Gateway/CLI también auto-migra
el almacén de sesiones + directorio de agente heredados al inicio para que history/auth/models lleguen a la
ruta por agente sin una ejecución manual de doctor. El auth de WhatsApp intencionalmente solo se
migra vía `openclaw doctor`.

### 4) Verificaciones de integridad de estado (persistencia de sesión, enrutamiento y seguridad)

El directorio de estado es el tronco cerebral operacional. Si desaparece, pierdes
sesiones, credenciales, logs y configuración (a menos que tengas respaldos en otro lugar).

Doctor verifica:

- **Directorio de estado faltante**: advierte sobre pérdida de estado catastrófica, pregunta para recrear
  el directorio, y te recuerda que no puede recuperar datos faltantes.
- **Permisos del directorio de estado**: verifica escribibilidad; ofrece reparar permisos
  (y emite una pista `chown` cuando se detecta desajuste de owner/group).
- **Directorios de sesión faltantes**: `sessions/` y el directorio del almacén de sesiones son
  requeridos para persistir el historial y evitar crashes `ENOENT`.
- **Desajuste de transcripción**: advierte cuando entradas de sesión recientes tienen archivos de
  transcripción faltantes.
- **Sesión principal "1-línea JSONL"**: marca cuando la transcripción principal tiene solo una
  línea (el historial no se está acumulando).
- **Múltiples directorios de estado**: advierte cuando existen múltiples carpetas `~/.openclaw` a través
  de directorios home o cuando `OPENCLAW_STATE_DIR` apunta a otro lugar (el historial puede
  dividirse entre instalaciones).
- **Recordatorio de modo remoto**: si `gateway.mode=remote`, doctor te recuerda ejecutarlo
  en el host remoto (el estado vive allí).
- **Permisos de archivo de configuración**: advierte si `~/.openclaw/openclaw.json` es
  legible por grupo/mundo y ofrece ajustar a `600`.

### 5) Salud de auth del modelo (expiración de OAuth)

Doctor inspecciona perfiles OAuth en el almacén de auth, advierte cuando los tokens están
expirando/expirados, y puede refrescarlos cuando es seguro. Si el perfil de Anthropic Claude Code
está obsoleto, sugiere ejecutar `claude setup-token` (o pegar un setup-token).
Los prompts de refresco solo aparecen cuando se ejecuta interactivamente (TTY); `--non-interactive`
omite intentos de refresco.

Doctor también reporta perfiles de auth que son temporalmente inutilizables debido a:

- cooldowns cortos (límites de tasa/timeouts/fallas de auth)
- deshabilitaciones más largas (fallas de facturación/crédito)

### 6) Validación de modelo de hooks

Si `hooks.gmail.model` está establecido, doctor valida la referencia del modelo contra el
catálogo y allowlist y advierte cuando no se resolverá o está desautorizado.

### 7) Reparación de imagen de sandbox

Cuando el sandboxing está habilitado, doctor verifica imágenes de Docker y ofrece construir o
cambiar a nombres heredados si la imagen actual falta.

### 8) Migraciones de servicio del gateway y pistas de limpieza

Doctor detecta servicios de gateway heredados (launchd/systemd/schtasks) y
ofrece eliminarlos e instalar el servicio OpenClaw usando el puerto de gateway actual. También puede escanear servicios extra parecidos al gateway e imprimir pistas de limpieza.
Los servicios de gateway OpenClaw con nombre de perfil se consideran de primera clase y no se
marcan como "extra".

### 9) Advertencias de seguridad

Doctor emite advertencias cuando un proveedor está abierto a DMs sin un allowlist, o
cuando una política está configurada de manera peligrosa.

### 10) linger de systemd (Linux)

Si se ejecuta como servicio de usuario systemd, doctor asegura que el lingering esté habilitado para que el
gateway permanezca vivo después del logout.

### 11) Estado de habilidades

Doctor imprime un resumen rápido de habilidades elegibles/faltantes/bloqueadas para el
workspace actual.

### 12) Verificaciones de auth del gateway (token local)

Doctor advierte cuando `gateway.auth` falta en un gateway local y ofrece
generar un token. Usa `openclaw doctor --generate-gateway-token` para forzar la creación de token
en automatización.

### 13) Verificación de salud del gateway + reinicio

Doctor ejecuta una verificación de salud y ofrece reiniciar el gateway cuando parece
poco saludable.

### 14) Advertencias de estado de canales

Si el gateway está saludable, doctor ejecuta una prueba de estado de canal y reporta
advertencias con correcciones sugeridas.

### 15) Auditoría de configuración de supervisor + reparación

Doctor verifica la configuración de supervisor instalada (launchd/systemd/schtasks) para
valores predeterminados faltantes o desactualizados (por ejemplo, dependencias network-online de systemd y
retraso de reinicio). Cuando encuentra un desajuste, recomienda una actualización y puede
reescribir el archivo de servicio/tarea a los valores predeterminados actuales.

Notas:

- `openclaw doctor` pregunta antes de reescribir configuración de supervisor.
- `openclaw doctor --yes` acepta los prompts de reparación predeterminados.
- `openclaw doctor --repair` aplica correcciones recomendadas sin prompts.
- `openclaw doctor --repair --force` sobrescribe configuraciones de supervisor personalizadas.
- Siempre puedes forzar una reescritura completa vía `openclaw gateway install --force`.

### 16) Runtime del gateway + diagnósticos de puerto

Doctor inspecciona el runtime del servicio (PID, último estado de salida) y advierte cuando el
servicio está instalado pero no se está ejecutando realmente. También verifica colisiones de puerto
en el puerto del gateway (predeterminado `18789`) y reporta causas probables (gateway ya
ejecutándose, túnel SSH).

### 17) Mejores prácticas de runtime del gateway

Doctor advierte cuando el servicio del gateway se ejecuta en Bun o una ruta de Node gestionada por versión
(`nvm`, `fnm`, `volta`, `asdf`, etc.). Los canales de WhatsApp + Telegram requieren Node,
y las rutas de version-manager pueden romperse después de actualizaciones porque el servicio no
carga tu init de shell. Doctor ofrece migrar a una instalación de Node del sistema cuando
esté disponible (Homebrew/apt/choco).

### 18) Escritura de configuración + metadatos del wizard

Doctor persiste cualquier cambio de configuración y marca metadatos del wizard para registrar la
ejecución de doctor.

### 19) Consejos de workspace (respaldo + sistema de memoria)

Doctor sugiere un sistema de memoria de workspace cuando falta e imprime un consejo de respaldo
si el workspace no está ya bajo git.

Ver [/concepts/agent-workspace](/es-ES/concepts/agent-workspace) para una guía completa de
estructura de workspace y respaldo git (recomendado GitHub o GitLab privado).
