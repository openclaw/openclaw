---
summary: "Referencia de la CLI para `openclaw plugins` (listar, instalar, habilitar/deshabilitar, diagnóstico)"
read_when:
  - Desea instalar o administrar plugins del Gateway en proceso
  - Desea depurar fallas de carga de plugins
title: "plugins"
---

# `openclaw plugins`

Administre plugins/extensiones del Gateway (cargados en proceso).

Relacionado:

- Sistema de plugins: [Plugins](/tools/plugin)
- Manifiesto del plugin + esquema: [Manifiesto del plugin](/plugins/manifest)
- Endurecimiento de seguridad: [Security](/gateway/security)

## Comandos

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

Los plugins incluidos se entregan con OpenClaw, pero comienzan deshabilitados. Use `plugins enable` para
activarlos.

Todos los plugins deben incluir un archivo `openclaw.plugin.json` con un JSON Schema en línea
(`configSchema`, incluso si está vacío). Los manifiestos o esquemas faltantes o inválidos impiden
que el plugin se cargue y hacen que falle la validación de la configuración.

### Instalar

```bash
openclaw plugins install <path-or-spec>
```

Nota de seguridad: trate la instalación de plugins como la ejecución de código. Prefiera versiones fijadas.

Archivos compatibles: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Use `--link` para evitar copiar un directorio local (se agrega a `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### Actualizar

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Las actualizaciones solo se aplican a los plugins instalados desde npm (registrados en `plugins.installs`).
