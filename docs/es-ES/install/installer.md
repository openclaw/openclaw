---
summary: "Cómo funcionan los scripts de instalación (install.sh, install-cli.sh, install.ps1), banderas y automatización"
read_when:
  - Quieres entender `openclaw.ai/install.sh`
  - Quieres automatizar instalaciones (CI / sin cabeza)
  - Quieres instalar desde un checkout de GitHub
title: "Internos del Instalador"
---

# Internos del instalador

OpenClaw incluye tres scripts de instalación, servidos desde `openclaw.ai`.

| Script                             | Plataforma           | Qué hace                                                                                                            |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | Instala Node si es necesario, instala OpenClaw mediante npm (predeterminado) o git, y puede ejecutar incorporación. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | Instala Node + OpenClaw en un prefijo local (`~/.openclaw`). No se requiere root.                                   |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Instala Node si es necesario, instala OpenClaw mediante npm (predeterminado) o git, y puede ejecutar incorporación. |

## Comandos rápidos

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```

  </Tab>
</Tabs>

<Note>
Si la instalación tiene éxito pero `openclaw` no se encuentra en una nueva terminal, ver [Solución de problemas de Node.js](/es-ES/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Recomendado para la mayoría de instalaciones interactivas en macOS/Linux/WSL.
</Tip>

### Flujo (install.sh)

<Steps>
  <Step title="Detectar SO">
    Soporta macOS y Linux (incluyendo WSL). Si se detecta macOS, instala Homebrew si falta.
  </Step>
  <Step title="Asegurar Node.js 22+">
    Verifica la versión de Node e instala Node 22 si es necesario (Homebrew en macOS, scripts de configuración de NodeSource en apt/dnf/yum de Linux).
  </Step>
  <Step title="Asegurar Git">
    Instala Git si falta.
  </Step>
  <Step title="Instalar OpenClaw">
    - Método `npm` (predeterminado): instalación npm global
    - Método `git`: clonar/actualizar repositorio, instalar dependencias con pnpm, construir, luego instalar wrapper en `~/.local/bin/openclaw`
  </Step>
  <Step title="Tareas post-instalación">
    - Ejecuta `openclaw doctor --non-interactive` en actualizaciones e instalaciones git (mejor esfuerzo)
    - Intenta incorporación cuando es apropiado (TTY disponible, incorporación no deshabilitada y verificaciones de bootstrap/config pasan)
    - Predetermina `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Detección de checkout de fuente

Si se ejecuta dentro de un checkout de OpenClaw (`package.json` + `pnpm-workspace.yaml`), el script ofrece:

- usar checkout (`git`), o
- usar instalación global (`npm`)

Si no hay TTY disponible y no se establece ningún método de instalación, predetermina a `npm` y advierte.

El script sale con código `2` para selección de método inválida o valores `--install-method` inválidos.

### Ejemplos (install.sh)

<Tabs>
  <Tab title="Predeterminado">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Omitir incorporación">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Instalación Git">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Simulación">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Referencia de banderas">

| Bandera                         | Descripción                                                              |
| ------------------------------- | ------------------------------------------------------------------------ |
| `--install-method npm\|git`     | Elegir método de instalación (predeterminado: `npm`). Alias: `--method`  |
| `--npm`                         | Atajo para método npm                                                    |
| `--git`                         | Atajo para método git. Alias: `--github`                                 |
| `--version <version\|dist-tag>` | versión npm o dist-tag (predeterminado: `latest`)                        |
| `--beta`                        | Usar dist-tag beta si está disponible, si no respaldo a `latest`         |
| `--git-dir <path>`              | Directorio de checkout (predeterminado: `~/openclaw`). Alias: `--dir`    |
| `--no-git-update`               | Omitir `git pull` para checkout existente                                |
| `--no-prompt`                   | Deshabilitar prompts                                                     |
| `--no-onboard`                  | Omitir incorporación                                                     |
| `--onboard`                     | Habilitar incorporación                                                  |
| `--dry-run`                     | Imprimir acciones sin aplicar cambios                                    |
| `--verbose`                     | Habilitar salida de depuración (`set -x`, registros notice-level de npm) |
| `--help`                        | Mostrar uso (`-h`)                                                       |

  </Accordion>

  <Accordion title="Referencia de variables de entorno">

| Variable                                    | Descripción                                                  |
| ------------------------------------------- | ------------------------------------------------------------ |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | Método de instalación                                        |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | versión npm o dist-tag                                       |
| `OPENCLAW_BETA=0\|1`                        | Usar beta si está disponible                                 |
| `OPENCLAW_GIT_DIR=<path>`                   | Directorio de checkout                                       |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | Alternar actualizaciones git                                 |
| `OPENCLAW_NO_PROMPT=1`                      | Deshabilitar prompts                                         |
| `OPENCLAW_NO_ONBOARD=1`                     | Omitir incorporación                                         |
| `OPENCLAW_DRY_RUN=1`                        | Modo simulación                                              |
| `OPENCLAW_VERBOSE=1`                        | Modo depuración                                              |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | Nivel de registro npm                                        |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Controlar comportamiento sharp/libvips (predeterminado: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Diseñado para entornos donde quieres todo bajo un prefijo local (predeterminado `~/.openclaw`) y sin dependencia de Node del sistema.
</Info>

### Flujo (install-cli.sh)

<Steps>
  <Step title="Instalar runtime Node local">
    Descarga tarball de Node (predeterminado `22.22.0`) a `<prefix>/tools/node-v<version>` y verifica SHA-256.
  </Step>
  <Step title="Asegurar Git">
    Si falta Git, intenta instalación mediante apt/dnf/yum en Linux o Homebrew en macOS.
  </Step>
  <Step title="Instalar OpenClaw bajo prefijo">
    Instala con npm usando `--prefix <prefix>`, luego escribe wrapper a `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Ejemplos (install-cli.sh)

<Tabs>
  <Tab title="Predeterminado">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Prefijo + versión personalizados">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Salida JSON de automatización">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Ejecutar incorporación">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Referencia de banderas">

| Bandera                | Descripción                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `--prefix <path>`      | Prefijo de instalación (predeterminado: `~/.openclaw`)                               |
| `--version <ver>`      | Versión de OpenClaw o dist-tag (predeterminado: `latest`)                            |
| `--node-version <ver>` | Versión de Node (predeterminado: `22.22.0`)                                          |
| `--json`               | Emitir eventos NDJSON                                                                |
| `--onboard`            | Ejecutar `openclaw onboard` después de instalar                                      |
| `--no-onboard`         | Omitir incorporación (predeterminado)                                                |
| `--set-npm-prefix`     | En Linux, forzar prefijo npm a `~/.npm-global` si el prefijo actual no es escribible |
| `--help`               | Mostrar uso (`-h`)                                                                   |

  </Accordion>

  <Accordion title="Referencia de variables de entorno">

| Variable                                    | Descripción                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | Prefijo de instalación                                                                             |
| `OPENCLAW_VERSION=<ver>`                    | Versión de OpenClaw o dist-tag                                                                     |
| `OPENCLAW_NODE_VERSION=<ver>`               | Versión de Node                                                                                    |
| `OPENCLAW_NO_ONBOARD=1`                     | Omitir incorporación                                                                               |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | Nivel de registro npm                                                                              |
| `OPENCLAW_GIT_DIR=<path>`                   | Ruta de búsqueda de limpieza heredada (usada al eliminar checkout antiguo de submódulo `Peekaboo`) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Controlar comportamiento sharp/libvips (predeterminado: `1`)                                       |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Flujo (install.ps1)

<Steps>
  <Step title="Asegurar PowerShell + entorno Windows">
    Requiere PowerShell 5+.
  </Step>
  <Step title="Asegurar Node.js 22+">
    Si falta, intenta instalación mediante winget, luego Chocolatey, luego Scoop.
  </Step>
  <Step title="Instalar OpenClaw">
    - Método `npm` (predeterminado): instalación npm global usando `-Tag` seleccionado
    - Método `git`: clonar/actualizar repositorio, instalar/construir con pnpm, e instalar wrapper en `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Tareas post-instalación">
    Agrega directorio bin necesario a PATH de usuario cuando sea posible, luego ejecuta `openclaw doctor --non-interactive` en actualizaciones e instalaciones git (mejor esfuerzo).
  </Step>
</Steps>

### Ejemplos (install.ps1)

<Tabs>
  <Tab title="Predeterminado">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Instalación Git">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Directorio git personalizado">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Simulación">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
  <Tab title="Traza de depuración">
    ```powershell
    # install.ps1 aún no tiene una bandera -Verbose dedicada.
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Referencia de banderas">

| Bandera                   | Descripción                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| `-InstallMethod npm\|git` | Método de instalación (predeterminado: `npm`)                     |
| `-Tag <tag>`              | dist-tag npm (predeterminado: `latest`)                           |
| `-GitDir <path>`          | Directorio de checkout (predeterminado: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`              | Omitir incorporación                                              |
| `-NoGitUpdate`            | Omitir `git pull`                                                 |
| `-DryRun`                 | Solo imprimir acciones                                            |

  </Accordion>

  <Accordion title="Referencia de variables de entorno">

| Variable                           | Descripción            |
| ---------------------------------- | ---------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | Método de instalación  |
| `OPENCLAW_GIT_DIR=<path>`          | Directorio de checkout |
| `OPENCLAW_NO_ONBOARD=1`            | Omitir incorporación   |
| `OPENCLAW_GIT_UPDATE=0`            | Deshabilitar git pull  |
| `OPENCLAW_DRY_RUN=1`               | Modo simulación        |

  </Accordion>
</AccordionGroup>

<Note>
Si se usa `-InstallMethod git` y falta Git, el script sale e imprime el enlace de Git para Windows.
</Note>

---

## CI y automatización

Usa banderas/variables de entorno no interactivas para ejecuciones predecibles.

<Tabs>
  <Tab title="install.sh (npm no interactivo)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (git no interactivo)">
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
  <Tab title="install.ps1 (omitir incorporación)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Solución de problemas

<AccordionGroup>
  <Accordion title="¿Por qué se requiere Git?">
    Git es requerido para el método de instalación `git`. Para instalaciones `npm`, Git aún se verifica/instala para evitar fallas `spawn git ENOENT` cuando las dependencias usan URLs git.
  </Accordion>

  <Accordion title="¿Por qué npm da EACCES en Linux?">
    Algunas configuraciones de Linux apuntan el prefijo global de npm a rutas propiedad de root. `install.sh` puede cambiar el prefijo a `~/.npm-global` y agregar exportaciones PATH a archivos rc de shell (cuando esos archivos existen).
  </Accordion>

  <Accordion title="Problemas sharp/libvips">
    Los scripts predeterminan `SHARP_IGNORE_GLOBAL_LIBVIPS=1` para evitar que sharp construya contra libvips del sistema. Para sobrescribir:

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Instala Git para Windows, reabre PowerShell, vuelve a ejecutar instalador.
  </Accordion>

  <Accordion title='Windows: "openclaw no se reconoce"'>
    Ejecuta `npm config get prefix`, agrega `\bin`, agrega ese directorio a PATH de usuario, luego reabre PowerShell.
  </Accordion>

  <Accordion title="Windows: cómo obtener salida detallada del instalador">
    `install.ps1` actualmente no expone un interruptor `-Verbose`.
    Usa trazado de PowerShell para diagnósticos a nivel de script:

    ```powershell
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

  </Accordion>

  <Accordion title="openclaw no encontrado después de instalar">
    Usualmente un problema de PATH. Ver [Solución de problemas de Node.js](/es-ES/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
