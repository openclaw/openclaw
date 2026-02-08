---
title: "Node.js"
summary: "Instale y configure Node.js para OpenClaw — requisitos de versión, opciones de instalación y solución de problemas de PATH"
read_when:
  - "Necesita instalar Node.js antes de instalar OpenClaw"
  - "Instaló OpenClaw pero `openclaw` no se encuentra como comando"
  - "npm install -g falla con problemas de permisos o PATH"
x-i18n:
  source_path: install/node.md
  source_hash: f848d6473a183090
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:50Z
---

# Node.js

OpenClaw requiere **Node 22 o superior**. El [script de instalación](/install#install-methods) detectará e instalará Node automáticamente — esta página es para cuando desea configurar Node por su cuenta y asegurarse de que todo esté conectado correctamente (versiones, PATH, instalaciones globales).

## Verifique su versión

```bash
node -v
```

Si esto imprime `v22.x.x` o superior, está listo. Si Node no está instalado o la versión es demasiado antigua, elija un método de instalación a continuación.

## Instalar Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (recomendado):

    ```bash
    brew install node
    ```

    O descargue el instalador de macOS desde [nodejs.org](https://nodejs.org/).

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

    O use un gestor de versiones (vea abajo).

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

    O descargue el instalador de Windows desde [nodejs.org](https://nodejs.org/).

  </Tab>
</Tabs>

<Accordion title="Uso de un gestor de versiones (nvm, fnm, mise, asdf)">
  Los gestores de versiones le permiten cambiar fácilmente entre versiones de Node. Opciones populares:

- [**fnm**](https://github.com/Schniz/fnm) — rápido, multiplataforma
- [**nvm**](https://github.com/nvm-sh/nvm) — ampliamente usado en macOS/Linux
- [**mise**](https://mise.jdx.dev/) — políglota (Node, Python, Ruby, etc.)

Ejemplo con fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Asegúrese de que su gestor de versiones esté inicializado en el archivo de inicio de su shell (`~/.zshrc` o `~/.bashrc`). Si no lo está, `openclaw` puede no encontrarse en nuevas sesiones de terminal porque el PATH no incluirá el directorio bin de Node.
  </Warning>
</Accordion>

## Solución de problemas

### `openclaw: command not found`

Esto casi siempre significa que el directorio bin global de npm no está en su PATH.

<Steps>
  <Step title="Encuentre su prefijo global de npm">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="Verifique si está en su PATH">
    ```bash
    echo "$PATH"
    ```

    Busque `<npm-prefix>/bin` (macOS/Linux) o `<npm-prefix>` (Windows) en la salida.

  </Step>
  <Step title="Añádalo a su archivo de inicio del shell">
    <Tabs>
      <Tab title="macOS / Linux">
        Agregue a `~/.zshrc` o `~/.bashrc`:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        Luego abra una nueva terminal (o ejecute `rehash` en zsh / `hash -r` en bash).
      </Tab>
      <Tab title="Windows">
        Agregue la salida de `npm prefix -g` a su PATH del sistema mediante Configuración → Sistema → Variables de entorno.
      </Tab>
    </Tabs>

  </Step>
</Steps>

### Errores de permisos en `npm install -g` (Linux)

Si ve errores `EACCES`, cambie el prefijo global de npm a un directorio con permisos de escritura para el usuario:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Agregue la línea `export PATH=...` a su `~/.bashrc` o `~/.zshrc` para que sea permanente.
