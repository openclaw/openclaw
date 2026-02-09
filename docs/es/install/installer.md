---
summary: "Cómo funcionan los scripts del instalador (install.sh, install-cli.sh, install.ps1), flags y automatización"
read_when:
  - Quiere entender `openclaw.ai/install.sh`
  - Quiere automatizar instalaciones (CI / sin interfaz)
  - Quiere instalar desde un checkout de GitHub
title: "Internos del instalador"
---

# Internos del instalador

OpenClaw incluye tres scripts de instalación, servidos desde `openclaw.ai`.

| Script                             | Plataforma                              | Qué hace                                                                                                                                          |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | Instala Node si es necesario, instala OpenClaw vía npm (predeterminado) o git, y puede ejecutar el onboarding. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | Instala Node + OpenClaw en un prefijo local (`~/.openclaw`). No requiere root.                 |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Instala Node si es necesario, instala OpenClaw vía npm (predeterminado) o git, y puede ejecutar el onboarding. |

## Comandos rápidos

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ````
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```
    ````

  </Tab>
</Tabs>

<Note>
Si la instalación tiene éxito pero `openclaw` no se encuentra en una nueva terminal, consulte [Solución de problemas de Node.js](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Recomendado para la mayoría de las instalaciones interactivas en macOS/Linux/WSL.
</Tip>

### Flujo (install.sh)

<Steps>
  <Step title="Detect OS">
    Admite macOS y Linux (incluido WSL). Si se detecta macOS, instala Homebrew si falta.
  </Step>
  <Step title="Ensure Node.js 22+">
    Comprueba la versión de Node e instala Node 22 si es necesario (Homebrew en macOS, scripts de configuración de NodeSource en Linux apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    Instala Git si falta.
  </Step>
  <Step title="Install OpenClaw">
    - Método `npm` (predeterminado): instalación global con npm
    - Método `git`: clonar/actualizar el repositorio, instalar dependencias con pnpm, compilar y luego instalar el wrapper en `~/.local/bin/openclaw`
  </Step>
  <Step title="Post-install tasks">
    - Ejecuta `openclaw doctor --non-interactive` en actualizaciones e instalaciones por git (mejor esfuerzo)
    - Intenta el onboarding cuando corresponde (TTY disponible, onboarding no deshabilitado y pasan las comprobaciones de bootstrap/configuración)
    - Predetermina `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Detección de checkout de código fuente

Si se ejecuta dentro de un checkout de OpenClaw (`package.json` + `pnpm-workspace.yaml`), el script ofrece:

- usar el checkout (`git`), o
- usar la instalación global (`npm`)

Si no hay TTY disponible y no se establece un método de instalación, se usa por defecto `npm` y se muestra una advertencia.

El script finaliza con el código `2` para una selección de método no válida o valores de `--install-method` no válidos.

### Ejemplos (install.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                              | Descripción                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--install-method npm\\|git`     | Elegir método de instalación (predeterminado: `npm`). Alias: `--method` |
| `--npm`                           | Atajo para el método npm                                                                                                                   |
| `--git`                           | Atajo para el método git. Alias: `--github`                                                                |
| `--version <version\\|dist-tag>` | Versión de npm o dist-tag (predeterminado: `latest`)                                                    |
| `--beta`                          | Usar dist-tag beta si está disponible; de lo contrario, volver a `latest`                                                                  |
| `--git-dir <path>`                | Directorio de checkout (predeterminado: `~/openclaw`). Alias: `--dir`   |
| `--no-git-update`                 | Omitir `git pull` para un checkout existente                                                                                               |
| `--no-prompt`                     | Deshabilitar solicitudes                                                                                                                   |
| `--no-onboard`                    | Omitir onboarding                                                                                                                          |
| `--onboard`                       | Habilitar onboarding                                                                                                                       |
| `--dry-run`                       | Imprimir acciones sin aplicar cambios                                                                                                      |
| `--verbose`                       | Habilitar salida de depuración (`set -x`, registros de npm a nivel notice)                                              |
| `--help`                          | Mostrar uso (`-h`)                                                                                                      |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                        | Descripción                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | Método de instalación                                                                                 |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | Versión de npm o dist-tag                                                                             |
| `OPENCLAW_BETA=0\\|1`                          | Usar beta si está disponible                                                                          |
| `OPENCLAW_GIT_DIR=<path>`                       | Directorio de checkout                                                                                |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | Alternar actualizaciones por git                                                                      |
| `OPENCLAW_NO_PROMPT=1`                          | Deshabilitar solicitudes                                                                              |
| `OPENCLAW_NO_ONBOARD=1`                         | Omitir onboarding                                                                                     |
| `OPENCLAW_DRY_RUN=1`                            | Modo de ejecución seca                                                                                |
| `OPENCLAW_VERBOSE=1`                            | Modo de depuración                                                                                    |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | Nivel de registro de npm                                                                              |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Controlar el comportamiento de sharp/libvips (predeterminado: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Diseñado para entornos donde quiere que todo esté bajo un prefijo local (predeterminado `~/.openclaw`) y sin dependencia de Node del sistema.
</Info>

### Flujo (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Descarga el tarball de Node (predeterminado `22.22.0`) en `<prefix>/tools/node-v<version>` y verifica SHA-256.
  </Step>
  <Step title="Ensure Git">
    Si Git falta, intenta instalarlo vía apt/dnf/yum en Linux o Homebrew en macOS.
  </Step>
  <Step title="Install OpenClaw under prefix">
    Instala con npm usando `--prefix <prefix>`, luego escribe el wrapper en `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Ejemplos (install-cli.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                   | Descripción                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Prefijo de instalación (predeterminado: `~/.openclaw`)    |
| `--version <ver>`      | Versión de OpenClaw o dist-tag (predeterminado: `latest`) |
| `--node-version <ver>` | Versión de Node (predeterminado: `22.22.0`)               |
| `--json`               | Emitir eventos NDJSON                                                                        |
| `--onboard`            | Ejecutar `openclaw onboard` después de la instalación                                        |
| `--no-onboard`         | Omitir onboarding (predeterminado)                                        |
| `--set-npm-prefix`     | En Linux, forzar el prefijo de npm a `~/.npm-global` si el prefijo actual no es escribible   |
| `--help`               | Mostrar uso (`-h`)                                                        |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                        | Descripción                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | Prefijo de instalación                                                                                                    |
| `OPENCLAW_VERSION=<ver>`                        | Versión de OpenClaw o dist-tag                                                                                            |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Versión de Node                                                                                                           |
| `OPENCLAW_NO_ONBOARD=1`                         | Omitir onboarding                                                                                                         |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | Nivel de registro de npm                                                                                                  |
| `OPENCLAW_GIT_DIR=<path>`                       | Ruta de búsqueda de limpieza heredada (usada al eliminar un checkout antiguo del submódulo `Peekaboo`) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Controlar el comportamiento de sharp/libvips (predeterminado: `1`)                     |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Flujo (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    Requiere PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    Si falta, intenta instalar vía winget, luego Chocolatey y después Scoop.
  </Step>
  <Step title="Install OpenClaw">
    - Método `npm` (predeterminado): instalación global con npm usando el `-Tag` seleccionado
    - Método `git`: clonar/actualizar el repositorio, instalar/compilar con pnpm e instalar el wrapper en `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Post-install tasks">
    Agrega el directorio bin necesario al PATH del usuario cuando es posible, luego ejecuta `openclaw doctor --non-interactive` en actualizaciones e instalaciones por git (mejor esfuerzo).
  </Step>
</Steps>

### Ejemplos (install.ps1)

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                        | Descripción                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | Método de instalación (predeterminado: `npm`)                      |
| `-Tag <tag>`                | Dist-tag de npm (predeterminado: `latest`)                         |
| `-GitDir <path>`            | Directorio de checkout (predeterminado: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | Omitir onboarding                                                                                     |
| `-NoGitUpdate`              | Omitir `git pull`                                                                                     |
| `-DryRun`                   | Imprimir solo acciones                                                                                |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                             | Descripción            |
| ------------------------------------ | ---------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | Método de instalación  |
| `OPENCLAW_GIT_DIR=<path>`            | Directorio de checkout |
| `OPENCLAW_NO_ONBOARD=1`              | Omitir onboarding      |
| `OPENCLAW_GIT_UPDATE=0`              | Deshabilitar git pull  |
| `OPENCLAW_DRY_RUN=1`                 | Modo de ejecución seca |

  </Accordion>
</AccordionGroup>

<Note>
Si se usa `-InstallMethod git` y Git falta, el script finaliza e imprime el enlace de Git para Windows.
</Note>

---

## CI y automatización

Use flags/variables de entorno no interactivos para ejecuciones predecibles.

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Solución de problemas

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git es necesario para el método de instalación `git`. Para instalaciones `npm`, Git aún se comprueba/instala para evitar fallos `spawn git ENOENT` cuando las dependencias usan URLs de git.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    Algunas configuraciones de Linux apuntan el prefijo global de npm a rutas propiedad de root. `install.sh` puede cambiar el prefijo a `~/.npm-global` y agregar exportaciones de PATH a archivos rc del shell (cuando esos archivos existen).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    Los scripts predeterminan `SHARP_IGNORE_GLOBAL_LIBVIPS=1` para evitar que sharp compile contra libvips del sistema. Para sobrescribirlo:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Instale Git para Windows, reabra PowerShell y vuelva a ejecutar el instalador.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Ejecute `npm config get prefix`, agregue `\bin`, añada ese directorio al PATH del usuario y luego reabra PowerShell.
  </Accordion>

  <Accordion title="openclaw not found after install">
    Normalmente es un problema de PATH. Consulte [Solución de problemas de Node.js](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
