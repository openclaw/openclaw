---
summary: "Instalar OpenClaw — script instalador, npm/pnpm, desde código fuente, Docker y más"
read_when:
  - Necesitas un método de instalación distinto al inicio rápido de Comenzando
  - Quieres desplegar en una plataforma en la nube
  - Necesitas actualizar, migrar o desinstalar
title: "Instalación"
---

# Instalación

¿Ya seguiste [Comenzando](/start/getting-started)? Ya estás listo — esta página es para métodos de instalación alternativos, instrucciones específicas de plataforma y mantenimiento.

## Requisitos del sistema

- **[Node 22+](/install/node)** (el [script instalador](#install-methods) lo instalará si falta)
- macOS, Linux o Windows
- `pnpm` solo si construyes desde código fuente

<Note>
En Windows, recomendamos encarecidamente ejecutar OpenClaw bajo [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).
</Note>

## Métodos de instalación

<Tip>
El **script instalador** es la forma recomendada de instalar OpenClaw. Maneja la detección de Node, instalación e incorporación en un solo paso.
</Tip>

<AccordionGroup>
  <Accordion title="Script instalador" icon="rocket" defaultOpen>
    Descarga el CLI, lo instala globalmente vía npm y lanza el asistente de incorporación.

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

    Eso es todo — el script maneja la detección de Node, instalación e incorporación.

    Para omitir la incorporación y solo instalar el binario:

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

    Para todas las banderas, variables de entorno y opciones de CI/automatización, consulta [Internos del instalador](/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Si ya tienes Node 22+ y prefieres gestionar la instalación tú mismo:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="¿Errores de compilación de sharp?">
          Si tienes libvips instalado globalmente (común en macOS vía Homebrew) y `sharp` falla, fuerza binarios precompilados:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          Si ves `sharp: Please add node-gyp to your dependencies`, instala herramientas de compilación (macOS: Xcode CLT + `npm install -g node-gyp`) o usa la variable de entorno arriba.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # aprobar openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm requiere aprobación explícita para paquetes con scripts de compilación. Después de que la primera instalación muestre la advertencia "Ignored build scripts", ejecuta `pnpm approve-builds -g` y selecciona los paquetes listados.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="Desde código fuente" icon="github">
    Para colaboradores o cualquiera que quiera ejecutar desde un checkout local.

    <Steps>
      <Step title="Clonar y construir">
        Clona el [repositorio OpenClaw](https://github.com/openclaw/openclaw) y construye:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Enlazar el CLI">
        Hacer disponible el comando `openclaw` globalmente:

        ```bash
        pnpm link --global
        ```

        Alternativamente, omite el enlace y ejecuta comandos vía `pnpm openclaw ...` desde dentro del repositorio.
      </Step>
      <Step title="Ejecutar incorporación">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    Para flujos de trabajo de desarrollo más profundos, consulta [Configuración](/start/setup).

  </Accordion>
</AccordionGroup>

## Otros métodos de instalación

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Despliegues en contenedor o sin interfaz gráfica.
  </Card>
  <Card title="Podman" href="/install/podman" icon="container">
    Contenedor sin root: ejecuta `setup-podman.sh` una vez, luego el script de lanzamiento.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Instalación declarativa vía Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Aprovisionamiento automatizado de flota.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Uso solo CLI vía el runtime Bun.
  </Card>
</CardGroup>

## Después de la instalación

Verifica que todo esté funcionando:

```bash
openclaw doctor         # verificar problemas de configuración
openclaw status         # estado del gateway
openclaw dashboard      # abrir la UI del navegador
```

Si necesitas rutas de runtime personalizadas, usa:

- `OPENCLAW_HOME` para rutas internas basadas en el directorio home
- `OPENCLAW_STATE_DIR` para la ubicación del estado mutable
- `OPENCLAW_CONFIG_PATH` para la ubicación del archivo de configuración

Consulta [Variables de entorno](/help/environment) para precedencia y detalles completos.

## Solución de problemas: `openclaw` no encontrado

<Accordion title="Diagnóstico y corrección de PATH">
  Diagnóstico rápido:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Si `$(npm prefix -g)/bin` (macOS/Linux) o `$(npm prefix -g)` (Windows) **no** está en tu `$PATH`, tu shell no puede encontrar binarios globales de npm (incluyendo `openclaw`).

Corrección — agrégalo a tu archivo de inicio de shell (`~/.zshrc` o `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

En Windows, agrega la salida de `npm prefix -g` a tu PATH.

Luego abre una nueva terminal (o `rehash` en zsh / `hash -r` en bash).
</Accordion>

## Actualizar / desinstalar

<CardGroup cols={3}>
  <Card title="Actualizar" href="/install/updating" icon="refresh-cw">
    Mantén OpenClaw actualizado.
  </Card>
  <Card title="Migrar" href="/install/migrating" icon="arrow-right">
    Mover a una nueva máquina.
  </Card>
  <Card title="Desinstalar" href="/install/uninstall" icon="trash-2">
    Eliminar OpenClaw completamente.
  </Card>
</CardGroup>
