---
summary: "Mover (migrar) una instalación de OpenClaw de una máquina a otra"
read_when:
  - Estás moviendo OpenClaw a una nueva laptop/servidor
  - Quieres preservar sesiones, autenticación e inicios de sesión de canales (WhatsApp, etc.)
title: "Guía de Migración"
---

# Migrar OpenClaw a una nueva máquina

Esta guía migra un Gateway de OpenClaw de una máquina a otra **sin rehacer la incorporación**.

La migración es conceptualmente simple:

- Copiar el **directorio de estado** (`$OPENCLAW_STATE_DIR`, predeterminado: `~/.openclaw/`) — esto incluye config, autenticación, sesiones y estado de canal.
- Copiar tu **espacio de trabajo** (`~/.openclaw/workspace/` por defecto) — esto incluye tus archivos de agente (memoria, prompts, etc.).

Pero hay trampas comunes alrededor de **perfiles**, **permisos** y **copias parciales**.

## Antes de empezar (qué estás migrando)

### 1) Identificar tu directorio de estado

La mayoría de instalaciones usan el predeterminado:

- **Directorio de estado:** `~/.openclaw/`

Pero puede ser diferente si usas:

- `--profile <name>` (a menudo se convierte en `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

Si no estás seguro, ejecuta en la **antigua** máquina:

```bash
openclaw status
```

Busca menciones de `OPENCLAW_STATE_DIR` / perfil en la salida. Si ejecutas múltiples gateways, repite para cada perfil.

### 2) Identificar tu espacio de trabajo

Predeterminados comunes:

- `~/.openclaw/workspace/` (espacio de trabajo recomendado)
- una carpeta personalizada que creaste

Tu espacio de trabajo es donde viven archivos como `MEMORY.md`, `USER.md` y `memory/*.md`.

### 3) Entender qué preservarás

Si copias **ambos** el directorio de estado y el espacio de trabajo, mantienes:

- Configuración del Gateway (`openclaw.json`)
- Perfiles de autenticación / claves de API / tokens OAuth
- Historial de sesiones + estado del agente
- Estado de canal (ej. inicio de sesión/sesión de WhatsApp)
- Tus archivos de espacio de trabajo (memoria, notas de habilidades, etc.)

Si copias **solo** el espacio de trabajo (ej., mediante Git), **no** preservas:

- sesiones
- credenciales
- inicios de sesión de canales

Esos viven bajo `$OPENCLAW_STATE_DIR`.

## Pasos de migración (recomendado)

### Paso 0 — Hacer un respaldo (máquina antigua)

En la **antigua** máquina, detén el gateway primero para que los archivos no estén cambiando durante la copia:

```bash
openclaw gateway stop
```

(Opcional pero recomendado) archivar el directorio de estado y el espacio de trabajo:

```bash
# Ajusta las rutas si usas un perfil o ubicaciones personalizadas
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Si tienes múltiples perfiles/directorios de estado (ej. `~/.openclaw-main`, `~/.openclaw-work`), archiva cada uno.

### Paso 1 — Instalar OpenClaw en la nueva máquina

En la **nueva** máquina, instala el CLI (y Node si es necesario):

- Ver: [Install](/es-ES/install)

En esta etapa, está bien si la incorporación crea un `~/.openclaw/` nuevo — lo sobrescribirás en el siguiente paso.

### Paso 2 — Copiar el directorio de estado + espacio de trabajo a la nueva máquina

Copiar **ambos**:

- `$OPENCLAW_STATE_DIR` (predeterminado `~/.openclaw/`)
- tu espacio de trabajo (predeterminado `~/.openclaw/workspace/`)

Enfoques comunes:

- `scp` los tarballs y extraer
- `rsync -a` sobre SSH
- unidad externa

Después de copiar, asegura:

- Los directorios ocultos fueron incluidos (ej. `.openclaw/`)
- La propiedad de archivos es correcta para el usuario que ejecuta el gateway

### Paso 3 — Ejecutar Doctor (migraciones + reparación de servicio)

En la **nueva** máquina:

```bash
openclaw doctor
```

Doctor es el comando "seguro aburrido". Repara servicios, aplica migraciones de configuración y advierte sobre desajustes.

Luego:

```bash
openclaw gateway restart
openclaw status
```

## Trampas comunes (y cómo evitarlas)

### Trampa: desajuste de perfil / directorio de estado

Si ejecutaste el gateway antiguo con un perfil (o `OPENCLAW_STATE_DIR`), y el nuevo gateway usa uno diferente, verás síntomas como:

- cambios de configuración que no surten efecto
- canales faltantes / desconectados
- historial de sesión vacío

Corrección: ejecuta el gateway/servicio usando el **mismo** perfil/directorio de estado que migraste, luego vuelve a ejecutar:

```bash
openclaw doctor
```

### Trampa: copiar solo `openclaw.json`

`openclaw.json` no es suficiente. Muchos proveedores almacenan estado bajo:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Siempre migra la carpeta `$OPENCLAW_STATE_DIR` completa.

### Trampa: permisos / propiedad

Si copiaste como root o cambiaste usuarios, el gateway puede fallar al leer credenciales/sesiones.

Corrección: asegura que el directorio de estado + espacio de trabajo sean propiedad del usuario que ejecuta el gateway.

### Trampa: migrar entre modos remoto/local

- Si tu UI (WebUI/TUI) apunta a un gateway **remoto**, el host remoto posee el almacén de sesiones + espacio de trabajo.
- Migrar tu laptop no moverá el estado del gateway remoto.

Si estás en modo remoto, migra el **host del gateway**.

### Trampa: secretos en respaldos

`$OPENCLAW_STATE_DIR` contiene secretos (claves de API, tokens OAuth, credenciales de WhatsApp). Trata los respaldos como secretos de producción:

- almacenar cifrados
- evitar compartir sobre canales inseguros
- rotar claves si sospechas exposición

## Lista de verificación de verificación

En la nueva máquina, confirma:

- `openclaw status` muestra el gateway ejecutándose
- Tus canales todavía están conectados (ej. WhatsApp no requiere re-emparejamiento)
- El panel de control abre y muestra sesiones existentes
- Tus archivos de espacio de trabajo (memoria, configs) están presentes

## Relacionado

- [Doctor](/es-ES/gateway/doctor)
- [Gateway troubleshooting](/es-ES/gateway/troubleshooting)
- [¿Dónde almacena OpenClaw sus datos?](/es-ES/help/faq#where-does-openclaw-store-its-data)
