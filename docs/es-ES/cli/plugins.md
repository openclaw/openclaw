---
summary: "Referencia CLI para `openclaw plugins` (listar, instalar, desinstalar, habilitar/deshabilitar, doctor)"
read_when:
  - Quieres instalar o gestionar plugins de Gateway en proceso
  - Quieres depurar fallos de carga de plugins
title: "plugins"
---

# `openclaw plugins`

Gestionar plugins/extensiones de Gateway (cargados en proceso).

Relacionado:

- Sistema de plugins: [Plugins](/es-ES/tools/plugin)
- Manifiesto de plugin + esquema: [Manifiesto de plugin](/es-ES/plugins/manifest)
- Endurecimiento de seguridad: [Seguridad](/es-ES/gateway/security)

## Comandos

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins uninstall <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Los plugins empaquetados vienen con OpenClaw pero comienzan deshabilitados. Usa `plugins enable` para
activarlos.

Todos los plugins deben incluir un archivo `openclaw.plugin.json` con un JSON Schema en línea
(`configSchema`, incluso si está vacío). Los manifiestos o esquemas faltantes/inválidos impiden
que el plugin se cargue y fallan la validación de configuración.

### Instalar

```bash
openclaw plugins install <path-or-spec>
```

Nota de seguridad: trata las instalaciones de plugins como ejecutar código. Prefiere versiones ancladas.

Las especificaciones npm son **solo de registro** (nombre del paquete + versión/etiqueta opcional). Las
especificaciones git/URL/archivo son rechazadas. Las instalaciones de dependencias se ejecutan con `--ignore-scripts` por seguridad.

Archivos compatibles: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Usa `--link` para evitar copiar un directorio local (agrega a `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### Desinstalar

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` elimina registros de plugin de `plugins.entries`, `plugins.installs`,
la lista de permitidos de plugin, y entradas vinculadas de `plugins.load.paths` cuando sea aplicable.
Para plugins de memoria activos, el slot de memoria se restablece a `memory-core`.

Por defecto, desinstalar también elimina el directorio de instalación del plugin bajo la raíz
de extensiones del directorio de estado activo (`$OPENCLAW_STATE_DIR/extensions/<id>`). Usa
`--keep-files` para mantener los archivos en disco.

`--keep-config` es soportado como un alias obsoleto de `--keep-files`.

### Actualizar

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Las actualizaciones solo aplican a plugins instalados desde npm (rastreados en `plugins.installs`).
