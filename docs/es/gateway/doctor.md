---
summary: "Comando Doctor: comprobaciones de estado, migraciones de configuración y pasos de reparación"
read_when:
  - Al agregar o modificar migraciones de doctor
  - Al introducir cambios de configuración incompatibles
title: "Doctor"
---

# Doctor

`openclaw doctor` es la herramienta de reparación y migración para OpenClaw. Corrige
configuración/estado obsoletos, comprueba la salud y proporciona pasos de reparación accionables.

## Inicio rápido

```bash
openclaw doctor
```

### Sin interfaz / automatización

```bash
openclaw doctor --yes
```

Aceptar valores predeterminados sin solicitar confirmación (incluidos pasos de reinicio/servicio/sandbox cuando corresponda).

```bash
openclaw doctor --repair
```

Aplicar reparaciones recomendadas sin solicitar confirmación (reparaciones + reinicios cuando sea seguro).

```bash
openclaw doctor --repair --force
```

Aplicar también reparaciones agresivas (sobrescribe configuraciones personalizadas del supervisor).

```bash
openclaw doctor --non-interactive
```

Ejecutar sin solicitudes y aplicar solo migraciones seguras (normalización de configuración + movimientos de estado en disco). Omite acciones de reinicio/servicio/sandbox que requieren confirmación humana.
Las migraciones de estado heredadas se ejecutan automáticamente cuando se detectan.

```bash
openclaw doctor --deep
```

Escanear servicios del sistema en busca de instalaciones adicionales del gateway (launchd/systemd/schtasks).

Si desea revisar los cambios antes de escribir, abra primero el archivo de configuración:

```bash
cat ~/.openclaw/openclaw.json
```

## Qué hace (resumen)

- Actualización previa opcional para instalaciones desde git (solo interactivo).
- Comprobación de vigencia del protocolo de la UI (reconstruye la UI de Control cuando el esquema del protocolo es más reciente).
- Comprobación de estado + solicitud de reinicio.
- Resumen del estado de Skills (elegibles/faltantes/bloqueadas).
- Normalización de configuración para valores heredados.
- Advertencias de anulación del proveedor OpenCode Zen (`models.providers.opencode`).
- Migración de estado heredado en disco (sesiones/directorio del agente/autenticación de WhatsApp).
- Comprobaciones de integridad y permisos del estado (sesiones, transcripciones, directorio de estado).
- Comprobaciones de permisos del archivo de configuración (chmod 600) cuando se ejecuta localmente.
- Salud de autenticación del modelo: comprueba la expiración de OAuth, puede renovar tokens próximos a expirar e informa estados de enfriamiento/deshabilitado del perfil de autenticación.
- Detección de directorios de workspace adicionales (`~/openclaw`).
- Reparación de imagen de Sandbox cuando sandboxing está habilitado.
- Migración de servicios heredados y detección de gateways adicionales.
- Comprobaciones de tiempo de ejecución del Gateway (servicio instalado pero no en ejecución; etiqueta launchd en caché).
- Advertencias de estado de Canal (sondeadas desde el gateway en ejecución).
- Auditoría de configuración del supervisor (launchd/systemd/schtasks) con reparación opcional.
- Comprobaciones de mejores prácticas del tiempo de ejecución del Gateway (Node vs Bun, rutas de gestores de versiones).
- Diagnósticos de colisión de puertos del Gateway (predeterminado `18789`).
- Advertencias de seguridad por políticas de DM abiertas.
- Advertencias de autenticación del Gateway cuando no se establece `gateway.auth.token` (modo local; ofrece generación de token).
- Comprobación de linger de systemd en Linux.
- Comprobaciones de instalación desde el código fuente (desajuste de workspace pnpm, activos de UI faltantes, binario tsx faltante).
- Escribe configuración actualizada + metadatos del asistente.

## Comportamiento detallado y justificación

### 0. Actualización opcional (instalaciones desde git)

Si se trata de un checkout de git y doctor se ejecuta de forma interactiva, ofrece
actualizar (fetch/rebase/build) antes de ejecutar doctor.

### 1. Normalización de configuración

Si la configuración contiene formas de valores heredadas (por ejemplo `messages.ackReaction`
sin una anulación específica por canal), doctor las normaliza al esquema actual.

### 2. Migraciones de claves de configuración heredadas

Cuando la configuración contiene claves obsoletas, otros comandos se niegan a ejecutarse y le piden
que ejecute `openclaw doctor`.

Doctor hará lo siguiente:

- Explicar qué claves heredadas se encontraron.
- Mostrar la migración que aplicó.
- Reescribir `~/.openclaw/openclaw.json` con el esquema actualizado.

El Gateway también ejecuta automáticamente las migraciones de doctor al iniciarse cuando detecta un
formato de configuración heredado, por lo que las configuraciones obsoletas se reparan sin intervención manual.

Migraciones actuales:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → nivel superior `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) Anulaciones del proveedor OpenCode Zen

Si agregó `models.providers.opencode` (o `opencode-zen`) manualmente, esto
anula el catálogo integrado de OpenCode Zen de `@mariozechner/pi-ai`. Eso puede
forzar todos los modelos a una sola API o poner los costos en cero. Doctor advierte para que pueda
eliminar la anulación y restaurar el enrutamiento por modelo + costos.

### 3. Migraciones de estado heredado (diseño en disco)

Doctor puede migrar diseños antiguos en disco a la estructura actual:

- Almacén de sesiones + transcripciones:
  - de `~/.openclaw/sessions/` a `~/.openclaw/agents/<agentId>/sessions/`
- Directorio del agente:
  - de `~/.openclaw/agent/` a `~/.openclaw/agents/<agentId>/agent/`
- Estado de autenticación de WhatsApp (Baileys):
  - desde el heredado `~/.openclaw/credentials/*.json` (excepto `oauth.json`)
  - a `~/.openclaw/credentials/whatsapp/<accountId>/...` (id de cuenta predeterminado: `default`)

Estas migraciones son de mejor esfuerzo e idempotentes; doctor emitirá advertencias cuando
deje carpetas heredadas como copias de seguridad. El Gateway/CLI también migra automáticamente
las sesiones heredadas + el directorio del agente al iniciarse para que el historial/autenticación/modelos
queden en la ruta por agente sin ejecutar doctor manualmente. La autenticación de WhatsApp
intencionalmente solo se migra mediante `openclaw doctor`.

### 4. Comprobaciones de integridad del estado (persistencia de sesiones, enrutamiento y seguridad)

El directorio de estado es el tronco encefálico operativo. Si desaparece, pierde
sesiones, credenciales, registros y configuración (a menos que tenga copias de seguridad en otro lugar).

Doctor comprueba:

- **Falta el directorio de estado**: advierte sobre la pérdida catastrófica del estado, solicita recrear
  el directorio y le recuerda que no puede recuperar datos faltantes.
- **Permisos del directorio de estado**: verifica que se pueda escribir; ofrece reparar permisos
  (y emite una pista `chown` cuando se detecta un desajuste de propietario/grupo).
- **Faltan directorios de sesiones**: `sessions/` y el directorio del almacén de sesiones son
  necesarios para persistir el historial y evitar fallos `ENOENT`.
- **Desajuste de transcripciones**: advierte cuando entradas recientes de sesión carecen de
  archivos de transcripción.
- **Sesión principal “JSONL de una línea”**: marca cuando la transcripción principal tiene solo una
  línea (el historial no se acumula).
- **Múltiples directorios de estado**: advierte cuando existen varias carpetas `~/.openclaw` en
  distintos directorios home o cuando `OPENCLAW_STATE_DIR` apunta a otro lugar (el historial puede
  dividirse entre instalaciones).
- **Recordatorio de modo remoto**: si `gateway.mode=remote`, doctor le recuerda ejecutarlo
  en el host remoto (el estado vive allí).
- **Permisos del archivo de configuración**: advierte si `~/.openclaw/openclaw.json` es
  legible por grupo/mundo y ofrece ajustar a `600`.

### 5. Salud de autenticación del modelo (expiración de OAuth)

Doctor inspecciona perfiles OAuth en el almacén de autenticación, advierte cuando los tokens
están por expirar/expirados y puede renovarlos cuando es seguro. Si el perfil de Anthropic Claude Code
está obsoleto, sugiere ejecutar `claude setup-token` (o pegar un setup-token).
Las solicitudes de renovación solo aparecen cuando se ejecuta de forma interactiva (TTY); `--non-interactive`
omite intentos de renovación.

Doctor también informa perfiles de autenticación que están temporalmente inutilizables debido a:

- enfriamientos cortos (límites de tasa/tiempos de espera/fallos de autenticación)
- deshabilitaciones más largas (fallos de facturación/crédito)

### 6. Validación del modelo de Hooks

Si se establece `hooks.gmail.model`, doctor valida la referencia del modelo contra el
catálogo y la lista de permitidos y advierte cuando no se resolverá o no está permitido.

### 7. Reparación de imagen de Sandbox

Cuando sandboxing está habilitado, doctor comprueba las imágenes de Docker y ofrece construir
o cambiar a nombres heredados si falta la imagen actual.

### 8. Migraciones de servicios del Gateway y pistas de limpieza

Doctor detecta servicios heredados del gateway (launchd/systemd/schtasks) y
ofrece eliminarlos e instalar el servicio de OpenClaw usando el puerto actual del gateway. También puede escanear servicios tipo gateway adicionales e imprimir pistas de limpieza.
Los servicios del gateway de OpenClaw con nombre de perfil se consideran de primera clase y no
se marcan como "extra".

### 9. Advertencias de seguridad

Doctor emite advertencias cuando un proveedor está abierto a mensajes directos sin una lista de permitidos,
o cuando una política está configurada de manera peligrosa.

### 10. Linger de systemd (Linux)

Si se ejecuta como un servicio de usuario de systemd, doctor garantiza que el linger esté habilitado para que el
gateway permanezca activo después de cerrar sesión.

### 11. Estado de Skills

Doctor imprime un resumen rápido de Skills elegibles/faltantes/bloqueadas para el workspace actual.

### 12. Comprobaciones de autenticación del Gateway (token local)

Doctor advierte cuando falta `gateway.auth` en un gateway local y ofrece
generar un token. Use `openclaw doctor --generate-gateway-token` para forzar la creación del token
en automatización.

### 13. Comprobación de estado del Gateway + reinicio

Doctor ejecuta una comprobación de estado y ofrece reiniciar el gateway cuando parece
no estar saludable.

### 14. Advertencias de estado de Canal

Si el gateway está saludable, doctor ejecuta un sondeo del estado del canal e informa
advertencias con correcciones sugeridas.

### 15. Auditoría + reparación de configuración del supervisor

Doctor comprueba la configuración del supervisor instalada (launchd/systemd/schtasks) en busca de
valores predeterminados faltantes u obsoletos (p. ej., dependencias network-online de systemd y
retraso de reinicio). Cuando encuentra un desajuste, recomienda una actualización y puede
reescribir el archivo de servicio/tarea a los valores predeterminados actuales.

Notas:

- `openclaw doctor` solicita confirmación antes de reescribir la configuración del supervisor.
- `openclaw doctor --yes` acepta las solicitudes de reparación predeterminadas.
- `openclaw doctor --repair` aplica correcciones recomendadas sin solicitudes.
- `openclaw doctor --repair --force` sobrescribe configuraciones personalizadas del supervisor.
- Siempre puede forzar una reescritura completa mediante `openclaw gateway install --force`.

### 16. Diagnósticos de tiempo de ejecución del Gateway + puerto

Doctor inspecciona el tiempo de ejecución del servicio (PID, último estado de salida) y advierte cuando el
servicio está instalado pero no se está ejecutando realmente. También comprueba colisiones de puertos
en el puerto del gateway (predeterminado `18789`) e informa causas probables (gateway ya
en ejecución, túnel SSH).

### 17. Mejores prácticas de tiempo de ejecución del Gateway

Doctor advierte cuando el servicio del gateway se ejecuta en Bun o en una ruta de Node gestionada por
un gestor de versiones (`nvm`, `fnm`, `volta`, `asdf`, etc.). Los canales de WhatsApp + Telegram requieren Node,
y las rutas de gestores de versiones pueden romperse tras actualizaciones porque el servicio no
carga la inicialización del shell. Doctor ofrece migrar a una instalación de Node del sistema cuando
está disponible (Homebrew/apt/choco).

### 18. Escritura de configuración + metadatos del asistente

Doctor persiste cualquier cambio de configuración y sella metadatos del asistente para registrar la
ejecución de doctor.

### 19. Consejos del workspace (respaldo + sistema de memoria)

Doctor sugiere un sistema de memoria del workspace cuando falta e imprime un consejo de respaldo
si el workspace aún no está bajo git.

Vea [/concepts/agent-workspace](/concepts/agent-workspace) para una guía completa sobre la
estructura del workspace y el respaldo con git (se recomienda GitHub o GitLab privados).
