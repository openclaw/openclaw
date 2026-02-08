---
summary: "Instale OpenClaw — script de instalación, npm/pnpm, desde el código fuente, Docker y más"
read_when:
  - Necesita un método de instalación distinto del inicio rápido de Primeros pasos
  - Quiere implementar en una plataforma en la nube
  - Necesita actualizar, migrar o desinstalar
title: "Instalar"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:52Z
---

# Instalar

¿Ya siguió [Primeros pasos](/start/getting-started)? Todo listo — esta página es para métodos de instalación alternativos, instrucciones específicas por plataforma y mantenimiento.

## Requisitos del sistema

- **[Node 22+](/install/node)** (el [script de instalación](#install-methods) lo instalará si falta)
- macOS, Linux o Windows
- `pnpm` solo si compila desde el código fuente

<Note>
En Windows, recomendamos encarecidamente ejecutar OpenClaw bajo [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).
</Note>

## Métodos de instalación

<Tip>
El **script de instalación** es la forma recomendada de instalar OpenClaw. Gestiona la detección de Node, la instalación y el onboarding en un solo paso.
</Tip>

<AccordionGroup>
  <Accordion title="Script de instalación" icon="rocket" defaultOpen>
    Descarga la CLI, la instala globalmente mediante npm y lanza el asistente de onboarding.

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    Eso es todo — el script gestiona la detección de Node, la instalación y el onboarding.

    Para omitir el onboarding e instalar solo el binario:

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    Para todas las flags, variables de entorno y opciones de CI/automatización, consulte [Internos del instalador](/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Si ya tiene Node 22+ y prefiere gestionar la instalación usted mismo:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="¿errores de compilación de sharp?">
          Si tiene libvips instalado globalmente (común en macOS vía Homebrew) y `sharp` falla, fuerce los binarios precompilados:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          Si ve `sharp: Please add node-gyp to your dependencies`, instale las herramientas de compilación (macOS: Xcode CLT + `npm install -g node-gyp`) o use la variable de entorno anterior.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm requiere aprobación explícita para paquetes con scripts de compilación. Después de que la primera instalación muestre la advertencia "Ignored build scripts", ejecute `pnpm approve-builds -g` y seleccione los paquetes listados.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="Desde el código fuente" icon="github">
    Para colaboradores o cualquiera que quiera ejecutar desde un checkout local.

    <Steps>
      <Step title="Clonar y compilar">
        Clone el [repositorio de OpenClaw](https://github.com/openclaw/openclaw) y compile:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Vincular la CLI">
        Haga que el comando `openclaw` esté disponible globalmente:

        ```bash
        pnpm link --global
        ```

        Alternativamente, omita el vínculo y ejecute los comandos mediante `pnpm openclaw ...` desde dentro del repositorio.
      </Step>
      <Step title="Ejecutar onboarding">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    Para flujos de trabajo de desarrollo más profundos, consulte [Configuración](/start/setup).

  </Accordion>
</AccordionGroup>

## Otros métodos de instalación

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Implementaciones en contenedores o sin interfaz.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Instalación declarativa mediante Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Aprovisionamiento automatizado de flotas.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Uso solo de la CLI mediante el runtime Bun.
  </Card>
</CardGroup>

## Después de instalar

Verifique que todo esté funcionando:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Solución de problemas: `openclaw` no encontrado

<Accordion title="Diagnóstico y corrección de PATH">
  Diagnóstico rápido:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Si `$(npm prefix -g)/bin` (macOS/Linux) o `$(npm prefix -g)` (Windows) **no** está en su `$PATH`, su shell no puede encontrar los binarios globales de npm (incluido `openclaw`).

Corrección — agréguelo a su archivo de inicio del shell (`~/.zshrc` o `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

En Windows, agregue la salida de `npm prefix -g` a su PATH.

Luego abra una nueva terminal (o ejecute `rehash` en zsh / `hash -r` en bash).
</Accordion>

## Actualizar / desinstalar

<CardGroup cols={3}>
  <Card title="Actualización" href="/install/updating" icon="refresh-cw">
    Mantenga OpenClaw actualizado.
  </Card>
  <Card title="Migración" href="/install/migrating" icon="arrow-right">
    Muévase a una nueva máquina.
  </Card>
  <Card title="Desinstalar" href="/install/uninstall" icon="trash-2">
    Elimine OpenClaw por completo.
  </Card>
</CardGroup>
