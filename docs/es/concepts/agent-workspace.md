---
summary: "Espacio de trabajo del agente: ubicación, diseño y estrategia de respaldo"
read_when:
  - Necesita explicar el espacio de trabajo del agente o su diseño de archivos
  - Quiere respaldar o migrar un espacio de trabajo del agente
title: "Espacio de trabajo del agente"
---

# Espacio de trabajo del agente

El espacio de trabajo es el hogar del agente. Es el único directorio de trabajo utilizado para
las herramientas de archivos y para el contexto del espacio de trabajo. Manténgalo privado y trátelo como memoria.

Esto es independiente de `~/.openclaw/`, que almacena configuración, credenciales y
sesiones.

**Importante:** el espacio de trabajo es el **cwd predeterminado**, no un sandbox rígido. Las herramientas
resuelven las rutas relativas contra el espacio de trabajo, pero las rutas absolutas aún pueden
alcanzar otras ubicaciones en el host a menos que el sandboxing esté habilitado. Si necesita aislamiento, use
[`agents.defaults.sandbox`](/gateway/sandboxing) (y/o configuración de sandbox por agente).
Cuando el sandboxing está habilitado y `workspaceAccess` no es `"rw"`, las herramientas operan
dentro de un espacio de trabajo en sandbox bajo `~/.openclaw/sandboxes`, no en el espacio de trabajo del host.

## Ubicación predeterminada

- Predeterminado: `~/.openclaw/workspace`
- Si `OPENCLAW_PROFILE` está configurado y no es `"default"`, el valor predeterminado pasa a ser
  `~/.openclaw/workspace-<profile>`.
- Sobrescriba en `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` o `openclaw setup` crearán el
espacio de trabajo y sembrarán los archivos de bootstrap si faltan.

Si ya administra los archivos del espacio de trabajo por su cuenta, puede desactivar la creación de archivos de bootstrap:

```json5
{ agent: { skipBootstrap: true } }
```

## Carpetas adicionales del espacio de trabajo

Las instalaciones antiguas pueden haber creado `~/openclaw`. Mantener varios directorios de
espacio de trabajo puede causar una deriva confusa de autenticación o estado, porque solo un
espacio de trabajo está activo a la vez.

**Recomendación:** mantenga un único espacio de trabajo activo. Si ya no utiliza las
carpetas adicionales, archívelas o muévalas a la Papelera (por ejemplo, `trash ~/openclaw`).
Si intencionalmente mantiene varios espacios de trabajo, asegúrese de que
`agents.defaults.workspace` apunte al activo.

`openclaw doctor` advierte cuando detecta directorios adicionales del espacio de trabajo.

## Mapa de archivos del espacio de trabajo (qué significa cada archivo)

Estos son los archivos estándar que OpenClaw espera dentro del espacio de trabajo:

- `AGENTS.md`
  - Instrucciones operativas para el agente y cómo debe usar la memoria.
  - Se carga al inicio de cada sesión.
  - Buen lugar para reglas, prioridades y detalles de “cómo comportarse”.

- `SOUL.md`
  - Persona, tono y límites.
  - Se carga en cada sesión.

- `USER.md`
  - Quién es el usuario y cómo dirigirse a él.
  - Se carga en cada sesión.

- `IDENTITY.md`
  - El nombre del agente, vibra y emoji.
  - Se crea/actualiza durante el ritual de bootstrap.

- `TOOLS.md`
  - Notas sobre sus herramientas locales y convenciones.
  - No controla la disponibilidad de herramientas; es solo orientación.

- `HEARTBEAT.md`
  - Lista de verificación pequeña y opcional para ejecuciones de heartbeat.
  - Manténgala corta para evitar consumo de tokens.

- `BOOT.md`
  - Lista de verificación de inicio opcional ejecutada al reiniciar el Gateway cuando los ganchos internos están habilitados.
  - Manténgala corta; use la herramienta de mensajes para envíos salientes.

- `BOOTSTRAP.md`
  - Ritual de primera ejecución, de una sola vez.
  - Solo se crea para un espacio de trabajo completamente nuevo.
  - Elimínelo después de completar el ritual.

- `memory/YYYY-MM-DD.md`
  - Registro diario de memoria (un archivo por día).
  - Se recomienda leer hoy + ayer al inicio de la sesión.

- `MEMORY.md` (opcional)
  - Memoria curada a largo plazo.
  - Cárguela solo en la sesión principal y privada (no en contextos compartidos/grupales).

Consulte [Memory](/concepts/memory) para el flujo de trabajo y el vaciado automático de memoria.

- `skills/` (opcional)
  - Skills específicos del espacio de trabajo.
  - Sobrescribe Skills gestionados/paquetizados cuando los nombres colisionan.

- `canvas/` (opcional)
  - Archivos de la UI Canvas para visualizaciones de nodos (por ejemplo, `canvas/index.html`).

Si falta algún archivo de bootstrap, OpenClaw inyecta un marcador de “archivo faltante” en
la sesión y continúa. Los archivos de bootstrap grandes se truncan cuando se inyectan;
ajuste el límite con `agents.defaults.bootstrapMaxChars` (predeterminado: 20000).
`openclaw setup` puede recrear los valores predeterminados faltantes sin sobrescribir los
archivos existentes.

## Qué NO está en el espacio de trabajo

Estos viven bajo `~/.openclaw/` y NO deben confirmarse en el repositorio del espacio de trabajo:

- `~/.openclaw/openclaw.json` (configuración)
- `~/.openclaw/credentials/` (tokens OAuth, claves de API)
- `~/.openclaw/agents/<agentId>/sessions/` (transcripciones de sesiones + metadatos)
- `~/.openclaw/skills/` (Skills gestionados)

Si necesita migrar sesiones o configuración, cópielas por separado y manténgalas
fuera del control de versiones.

## Respaldo con Git (recomendado, privado)

Trate el espacio de trabajo como memoria privada. Colóquelo en un repositorio git **privado** para que esté
respaldado y sea recuperable.

Ejecute estos pasos en la máquina donde se ejecuta el Gateway (ahí es donde vive el
espacio de trabajo).

### 1. Inicializar el repositorio

Si git está instalado, los espacios de trabajo nuevos se inicializan automáticamente. Si este
espacio de trabajo aún no es un repositorio, ejecute:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Agregar un remoto privado (opciones fáciles para principiantes)

Opción A: UI web de GitHub

1. Cree un nuevo repositorio **privado** en GitHub.
2. No lo inicialice con un README (evita conflictos de merge).
3. Copie la URL remota HTTPS.
4. Agregue el remoto y haga push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Opción B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Opción C: UI web de GitLab

1. Cree un nuevo repositorio **privado** en GitLab.
2. No lo inicialice con un README (evita conflictos de merge).
3. Copie la URL remota HTTPS.
4. Agregue el remoto y haga push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Actualizaciones continuas

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## No confirme secretos

Incluso en un repositorio privado, evite almacenar secretos en el espacio de trabajo:

- Claves de API, tokens OAuth, contraseñas o credenciales privadas.
- Cualquier cosa bajo `~/.openclaw/`.
- Volcados en bruto de chats o adjuntos sensibles.

Si debe almacenar referencias sensibles, use marcadores de posición y mantenga el
secreto real en otro lugar (administrador de contraseñas, variables de entorno o `~/.openclaw/`).

Inicio sugerido de `.gitignore`:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Mover el espacio de trabajo a una nueva máquina

1. Clone el repositorio en la ruta deseada (predeterminada `~/.openclaw/workspace`).
2. Configure `agents.defaults.workspace` con esa ruta en `~/.openclaw/openclaw.json`.
3. Ejecute `openclaw setup --workspace <path>` para sembrar cualquier archivo faltante.
4. Si necesita sesiones, copie `~/.openclaw/agents/<agentId>/sessions/` desde la
   máquina anterior por separado.

## Notas avanzadas

- El enrutamiento multiagente puede usar diferentes espacios de trabajo por agente. Consulte
  [Channel routing](/channels/channel-routing) para la configuración de enrutamiento.
- Si `agents.defaults.sandbox` está habilitado, las sesiones que no son principales pueden usar espacios de trabajo
  en sandbox por sesión bajo `agents.defaults.sandbox.workspaceRoot`.
