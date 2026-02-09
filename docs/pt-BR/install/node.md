---
title: "Node.js"
summary: "Instale e configure o Node.js para o OpenClaw — requisitos de versão, opções de instalação e solução de problemas de PATH"
read_when:
  - "Você precisa instalar o Node.js antes de instalar o OpenClaw"
  - "Você instalou o OpenClaw, mas `openclaw` é um comando não encontrado"
  - "`npm install -g` falha com problemas de permissões ou PATH"
---

# Node.js

O OpenClaw requer **Node 22 ou mais recente**. O [script de instalação](/install#install-methods) detectará e instalará o Node automaticamente — esta página é para quando você quer configurar o Node por conta própria e garantir que tudo esteja corretamente conectado (versões, PATH, instalações globais).

## Verifique sua versão

```bash
node -v
```

Se isso imprimir `v22.x.x` ou superior, está tudo certo. Se o Node não estiver instalado ou a versão for muito antiga, escolha um método de instalação abaixo.

## Instalar Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (recomendado):

    ````
    ```bash
    brew install node
    ```
    
    Ou baixe o instalador do macOS em [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ````
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```
    
    **Fedora / RHEL:**
    
    ```bash
    sudo dnf install nodejs
    ```
    
    Ou use um gerenciador de versões (veja abaixo).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (recomendado):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    Ou baixe o instalador do Windows em [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Gerenciadores de versões permitem alternar facilmente entre versões do Node. Opções populares:

- [**fnm**](https://github.com/Schniz/fnm) — rápido, multiplataforma
- [**nvm**](https://github.com/nvm-sh/nvm) — amplamente usado no macOS/Linux
- [**mise**](https://mise.jdx.dev/) — poliglota (Node, Python, Ruby, etc.)

Exemplo com fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Certifique-se de que seu gerenciador de versões esteja inicializado no arquivo de inicialização do seu shell (`~/.zshrc` ou `~/.bashrc`). Se não estiver, `openclaw` pode não ser encontrado em novas sessões do terminal porque o PATH não incluirá o diretório bin do Node.
  </Warning>
</Accordion>

## Solução de problemas

### `openclaw: command not found`

Isso quase sempre significa que o diretório bin global do npm não está no seu PATH.

<Steps>
  <Step title="Find your global npm prefix">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="Check if it's on your PATH">
    ```bash
    echo "$PATH"
    ```

    ```
    Procure por `<npm-prefix>/bin` (macOS/Linux) ou `<npm-prefix>` (Windows) na saída.
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        Adicione a `~/.zshrc` ou `~/.bashrc`:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            Em seguida, abra um novo terminal (ou execute `rehash` no zsh / `hash -r` no bash).
          </Tab>
          <Tab title="Windows">
            Adicione a saída de `npm prefix -g` ao PATH do sistema via Configurações → Sistema → Variáveis de Ambiente.
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### Erros de permissão em `npm install -g` (Linux)

Se você vir erros `EACCES`, altere o prefixo global do npm para um diretório gravável pelo usuário:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Adicione a linha `export PATH=...` ao seu `~/.bashrc` ou `~/.zshrc` para torná-la permanente.
