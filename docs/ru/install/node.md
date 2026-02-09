---
title: "Node.js"
summary: "Установка и настройка Node.js для OpenClaw — требования к версиям, варианты установки и устранение проблем с PATH"
read_when:
  - "Вам нужно установить Node.js перед установкой OpenClaw"
  - "Вы установили OpenClaw, но `openclaw` — команда не найдена"
  - "npm install -g завершается с ошибками прав доступа или PATH"
---

# Node.js

OpenClaw требует **Node версии 22 или новее**. [Скрипт установщика](/install#install-methods) автоматически обнаружит и установит Node — эта страница предназначена для случаев, когда вы хотите настроить Node самостоятельно и убедиться, что всё подключено корректно (версии, PATH, глобальные установки).

## Проверка версии

```bash
node -v
```

Если выводится `v22.x.x` или выше — всё в порядке. Если Node не установлен или версия слишком старая, выберите способ установки ниже.

## Установка Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (рекомендуется):

    ````
    ```bash
    brew install node
    ```
    
    Либо загрузите установщик для macOS с [nodejs.org](https://nodejs.org/).
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
    
    Либо используйте менеджер версий (см. ниже).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (рекомендуется):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    Либо загрузите установщик для Windows с [nodejs.org](https://nodejs.org/).
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Менеджеры версий позволяют легко переключаться между версиями Node. Популярные варианты:

- [**fnm**](https://github.com/Schniz/fnm) — быстрый, кроссплатформенный
- [**nvm**](https://github.com/nvm-sh/nvm) — широко используется на macOS/Linux
- [**mise**](https://mise.jdx.dev/) — полиглот (Node, Python, Ruby и т. д.)

Пример с fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Убедитесь, что менеджер версий инициализируется в файле запуска вашей оболочки (`~/.zshrc` или `~/.bashrc`). Если это не так, `openclaw` может не находиться в новых сессиях терминала, поскольку PATH не будет включать каталог bin Node.
  </Warning>
</Accordion>

## Устранение неполадок

### `openclaw: command not found`

Это почти всегда означает, что каталог глобальных бинарников npm не добавлен в PATH.

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
    Ищите `<npm-prefix>/bin` (macOS/Linux) или `<npm-prefix>` (Windows) в выводе.
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        Добавьте в `~/.zshrc` или `~/.bashrc`:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            Затем откройте новый терминал (или выполните `rehash` в zsh / `hash -r` в bash).
          </Tab>
          <Tab title="Windows">
            Добавьте вывод `npm prefix -g` в системный PATH через «Параметры → Система → Переменные среды».
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### Ошибки прав доступа на `npm install -g` (Linux)

Если вы видите ошибки `EACCES`, переключите глобальный префикс npm на каталог с правами записи для пользователя:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Добавьте строку `export PATH=...` в `~/.bashrc` или `~/.zshrc`, чтобы сделать изменение постоянным.
