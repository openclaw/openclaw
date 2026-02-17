---
title: "Node.js"
summary: "Instalar y configurar Node.js para OpenClaw — requisitos de versión, opciones de instalación y solución de problemas de PATH"
read_when:
  - "Necesitas instalar Node.js antes de instalar OpenClaw"
  - "Instalaste OpenClaw pero `openclaw` es comando no encontrado"
  - "npm install -g falla con problemas de permisos o PATH"
---

# Node.js

OpenClaw requiere **Node 22 o más reciente**. El [script de instalación](/es-ES/install#install-methods) detectará e instalará Node automáticamente — esta página es para cuando quieras configurar Node tú mismo y asegurarte de que todo esté configurado correctamente (versiones, PATH, instalaciones globales).

## Verifica tu versión

```bash
node -v
```

Si esto imprime `v22.x.x` o superior, estás listo. Si Node no está instalado o la versión es demasiado antigua, elige un método de instalación a continuación.

## Instalar Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (recomendado):

    ```bash
    brew install node
    ```

    O descarga el instalador de macOS desde [nodejs.org](https://nodejs.org/).

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    O usa un gestor de versiones (ver abajo).

  </Tab>
  <Tab title="Windows">
    **winget** (recomendado):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    O descarga el instalador de Windows desde [nodejs.org](https://nodejs.org/).

  </Tab>
</Tabs>

<Accordion title="Usando un gestor de versiones (nvm, fnm, mise, asdf)">
  Los gestores de versiones te permiten cambiar entre versiones de Node fácilmente. Opciones populares:

- [**fnm**](https://github.com/Schniz/fnm) — rápido, multiplataforma
- [**nvm**](https://github.com/nvm-sh/nvm) — ampliamente usado en macOS/Linux
- [**mise**](https://mise.jdx.dev/) — políglota (Node, Python, Ruby, etc.)

Ejemplo con fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Asegúrate de que tu gestor de versiones esté inicializado en tu archivo de inicio de shell (`~/.zshrc` o `~/.bashrc`). Si no lo está, `openclaw` puede no encontrarse en nuevas sesiones de terminal porque el PATH no incluirá el directorio bin de Node.
  </Warning>
</Accordion>

## Solución de problemas

### `openclaw: command not found`

Esto casi siempre significa que el directorio bin global de npm no está en tu PATH.

<Steps>
  <Step title="Encuentra tu prefijo global de npm">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="Verifica si está en tu PATH">
    ```bash
    echo "$PATH"
    ```

    Busca `<npm-prefix>/bin` (macOS/Linux) o `<npm-prefix>` (Windows) en la salida.

  </Step>
  <Step title="Agrégalo a tu archivo de inicio de shell">
    <Tabs>
      <Tab title="macOS / Linux">
        Agrega a `~/.zshrc` o `~/.bashrc`:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        Luego abre una nueva terminal (o ejecuta `rehash` en zsh / `hash -r` en bash).
      </Tab>
      <Tab title="Windows">
        Agrega la salida de `npm prefix -g` a tu PATH del sistema mediante Settings → System → Environment Variables.
      </Tab>
    </Tabs>

  </Step>
</Steps>

### Errores de permisos en `npm install -g` (Linux)

Si ves errores `EACCES`, cambia el prefijo global de npm a un directorio escribible por el usuario:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Agrega la línea `export PATH=...` a tu `~/.bashrc` o `~/.zshrc` para hacerlo permanente.
