---
summary: "Guía de ClawHub: registro público de skills + flujos de trabajo de la CLI"
read_when:
  - Presentar ClawHub a nuevos usuarios
  - Instalar, buscar o publicar skills
  - Explicar las banderas de la CLI de ClawHub y el comportamiento de sincronización
title: "ClawHub"
---

# ClawHub

ClawHub es el **registro público de skills para OpenClaw**. Es un servicio gratuito: todas las skills son públicas, abiertas y visibles para todos para compartir y reutilizar. Una skill es simplemente una carpeta con un archivo `SKILL.md` (más archivos de texto de apoyo). Puede explorar skills en la app web o usar la CLI para buscar, instalar, actualizar y publicar skills.

Sitio: [clawhub.ai](https://clawhub.ai)

## Qué es ClawHub

- Un registro público de skills de OpenClaw.
- Un almacén versionado de paquetes de skills y metadatos.
- Una superficie de descubrimiento para búsqueda, etiquetas y señales de uso.

## Cómo funciona

1. Un usuario publica un paquete de skill (archivos + metadatos).
2. ClawHub almacena el paquete, analiza los metadatos y asigna una versión.
3. El registro indexa la skill para búsqueda y descubrimiento.
4. Los usuarios exploran, descargan e instalan skills en OpenClaw.

## Qué puede hacer

- Publicar nuevas skills y nuevas versiones de skills existentes.
- Descubrir skills por nombre, etiquetas o búsqueda.
- Descargar paquetes de skills e inspeccionar sus archivos.
- Reportar skills que sean abusivas o inseguras.
- Si es moderador, ocultar, mostrar, eliminar o bloquear.

## Para quién es (apto para principiantes)

Si quiere agregar nuevas capacidades a su agente de OpenClaw, ClawHub es la forma más fácil de encontrar e instalar skills. No necesita saber cómo funciona el backend. Puede:

- Buscar skills con lenguaje sencillo.
- Instalar una skill en su espacio de trabajo.
- Actualizar skills más adelante con un solo comando.
- Respaldar sus propias skills publicándolas.

## Inicio rápido (no técnico)

1. Instale la CLI (vea la siguiente sección).
2. Busque algo que necesite:
   - `clawhub search "calendar"`
3. Instale una skill:
   - `clawhub install <skill-slug>`
4. Inicie una nueva sesión de OpenClaw para que recoja la nueva skill.

## Instalar la CLI

Elija una:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## Cómo encaja en OpenClaw

De forma predeterminada, la CLI instala skills en `./skills` bajo su directorio de trabajo actual. Si hay un espacio de trabajo de OpenClaw configurado, `clawhub` recurre a ese espacio de trabajo a menos que usted anule `--workdir` (o `CLAWHUB_WORKDIR`). OpenClaw carga las skills del espacio de trabajo desde `<workspace>/skills` y las recogerá en la **siguiente** sesión. Si ya usa `~/.openclaw/skills` o skills empaquetadas, las skills del espacio de trabajo tienen prioridad.

Para más detalles sobre cómo se cargan, comparten y controlan las skills, vea
[Skills](/tools/skills).

## Visión general del sistema de skills

Una skill es un paquete versionado de archivos que enseña a OpenClaw cómo realizar una tarea específica. Cada publicación crea una nueva versión, y el registro mantiene un historial de versiones para que los usuarios puedan auditar cambios.

Una skill típica incluye:

- Un archivo `SKILL.md` con la descripción principal y el uso.
- Configuraciones opcionales, scripts o archivos de apoyo usados por la skill.
- Metadatos como etiquetas, resumen y requisitos de instalación.

ClawHub usa metadatos para impulsar el descubrimiento y exponer de forma segura las capacidades de las skills.
El registro también rastrea señales de uso (como estrellas y descargas) para mejorar el ranking y la visibilidad.

## Qué ofrece el servicio (funcionalidades)

- **Exploración pública** de skills y su contenido `SKILL.md`.
- **Búsqueda** impulsada por embeddings (búsqueda vectorial), no solo por palabras clave.
- **Versionado** con semver, registros de cambios y etiquetas (incluida `latest`).
- **Descargas** como un zip por versión.
- **Estrellas y comentarios** para retroalimentación de la comunidad.
- **Moderación** con ganchos para aprobaciones y auditorías.
- **API amigable con la CLI** para automatización y scripting.

## Seguridad y moderación

ClawHub es abierto por defecto. Cualquiera puede subir skills, pero una cuenta de GitHub debe tener al menos una semana de antigüedad para publicar. Esto ayuda a frenar abusos sin bloquear a colaboradores legítimos.

Reportes y moderación:

- Cualquier usuario con sesión iniciada puede reportar una skill.
- Los motivos del reporte son obligatorios y se registran.
- Cada usuario puede tener hasta 20 reportes activos a la vez.
- Las skills con más de 3 reportes únicos se ocultan automáticamente por defecto.
- Los moderadores pueden ver skills ocultas, mostrarlas, eliminarlas o bloquear usuarios.
- Abusar de la función de reportes puede resultar en bloqueos de cuenta.

¿Le interesa convertirse en moderador? Pregunte en el Discord de OpenClaw y contacte a un moderador o mantenedor.

## Comandos y parámetros de la CLI

Opciones globales (aplican a todos los comandos):

- `--workdir <dir>`: Directorio de trabajo (predeterminado: directorio actual; recurre al espacio de trabajo de OpenClaw).
- `--dir <dir>`: Directorio de skills, relativo al directorio de trabajo (predeterminado: `skills`).
- `--site <url>`: URL base del sitio (inicio de sesión en el navegador).
- `--registry <url>`: URL base de la API del registro.
- `--no-input`: Desactivar solicitudes (no interactivo).
- `-V, --cli-version`: Imprimir la versión de la CLI.

Autenticación:

- `clawhub login` (flujo del navegador) o `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Opciones:

- `--token <token>`: Pegar un token de API.
- `--label <label>`: Etiqueta almacenada para tokens de inicio de sesión en el navegador (predeterminado: `CLI token`).
- `--no-browser`: No abrir un navegador (requiere `--token`).

Búsqueda:

- `clawhub search "query"`
- `--limit <n>`: Máximo de resultados.

Instalar:

- `clawhub install <slug>`
- `--version <version>`: Instalar una versión específica.
- `--force`: Sobrescribir si la carpeta ya existe.

Actualizar:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: Actualizar a una versión específica (solo un slug).
- `--force`: Sobrescribir cuando los archivos locales no coinciden con ninguna versión publicada.

Listar:

- `clawhub list` (lee `.clawhub/lock.json`)

Publicar:

- `clawhub publish <path>`
- `--slug <slug>`: Slug de la skill.
- `--name <name>`: Nombre para mostrar.
- `--version <version>`: Versión semver.
- `--changelog <text>`: Texto del registro de cambios (puede estar vacío).
- `--tags <tags>`: Etiquetas separadas por comas (predeterminado: `latest`).

Eliminar/restaurar (solo propietario/admin):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Sincronizar (escanea skills locales + publica nuevas/actualizadas):

- `clawhub sync`
- `--root <dir...>`: Raíces de escaneo adicionales.
- `--all`: Subir todo sin solicitudes.
- `--dry-run`: Mostrar qué se subiría.
- `--bump <type>`: `patch|minor|major` para actualizaciones (predeterminado: `patch`).
- `--changelog <text>`: Registro de cambios para actualizaciones no interactivas.
- `--tags <tags>`: Etiquetas separadas por comas (predeterminado: `latest`).
- `--concurrency <n>`: Comprobaciones del registro (predeterminado: 4).

## Flujos de trabajo comunes para agentes

### Buscar skills

```bash
clawhub search "postgres backups"
```

### Descargar nuevas skills

```bash
clawhub install my-skill-pack
```

### Actualizar skills instaladas

```bash
clawhub update --all
```

### Respaldar sus skills (publicar o sincronizar)

Para una sola carpeta de skill:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

Para escanear y respaldar muchas skills a la vez:

```bash
clawhub sync --all
```

## Detalles avanzados (técnicos)

### Versionado y etiquetas

- Cada publicación crea una nueva `SkillVersion` **semver**.
- Las etiquetas (como `latest`) apuntan a una versión; mover etiquetas le permite revertir.
- Los registros de cambios se adjuntan por versión y pueden estar vacíos al sincronizar o publicar actualizaciones.

### Cambios locales vs versiones del registro

Las actualizaciones comparan el contenido local de la skill con las versiones del registro usando un hash de contenido. Si los archivos locales no coinciden con ninguna versión publicada, la CLI pregunta antes de sobrescribir (o requiere `--force` en ejecuciones no interactivas).

### Escaneo de sincronización y raíces alternativas

`clawhub sync` escanea primero su directorio de trabajo actual. Si no se encuentran skills, recurre a ubicaciones heredadas conocidas (por ejemplo `~/openclaw/skills` y `~/.openclaw/skills`). Esto está diseñado para encontrar instalaciones de skills más antiguas sin banderas adicionales.

### Almacenamiento y archivo de bloqueo

- Las skills instaladas se registran en `.clawhub/lock.json` bajo su directorio de trabajo.
- Los tokens de autenticación se almacenan en el archivo de configuración de la CLI de ClawHub (anule mediante `CLAWHUB_CONFIG_PATH`).

### Telemetría (conteos de instalación)

Cuando ejecuta `clawhub sync` mientras ha iniciado sesión, la CLI envía una instantánea mínima para calcular conteos de instalación. Puede desactivar esto por completo:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Variables de entorno

- `CLAWHUB_SITE`: Anular la URL del sitio.
- `CLAWHUB_REGISTRY`: Anular la URL de la API del registro.
- `CLAWHUB_CONFIG_PATH`: Anular dónde la CLI almacena el token/configuración.
- `CLAWHUB_WORKDIR`: Anular el directorio de trabajo predeterminado.
- `CLAWHUB_DISABLE_TELEMETRY=1`: Desactivar la telemetría en `sync`.
