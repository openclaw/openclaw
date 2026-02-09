---
title: "Node.js"
summary: "OpenClaw için Node.js’i yükleyin ve yapılandırın — sürüm gereksinimleri, yükleme seçenekleri ve PATH sorun giderme"
read_when:
  - "OpenClaw’ı yüklemeden önce Node.js yüklemeniz gerekiyor"
  - "OpenClaw’ı yüklediniz ancak `openclaw` komutu bulunamadı"
  - "npm install -g izinler veya PATH sorunları nedeniyle başarısız oluyor"
---

# Node.js

OpenClaw, **Node 22 veya daha yeni** bir sürüm gerektirir. [Yükleyici betik](/install#install-methods) Node’u otomatik olarak algılar ve yükler — bu sayfa, Node’u kendiniz kurmak ve her şeyin doğru şekilde bağlandığından emin olmak (sürümler, PATH, global yüklemeler) istediğiniz durumlar içindir.

## Sürümünüzü kontrol edin

```bash
node -v
```

Bu komut `v22.x.x` veya daha yeni bir sürüm yazdırıyorsa sorun yok. Node yüklü değilse veya sürüm çok eskiyse, aşağıdan bir yükleme yöntemi seçin.

## Node’u yükleyin

<Tabs>
  <Tab title="macOS">
    **Homebrew** (önerilen):

    ````
    ```bash
    brew install node
    ```
    
    Ya da macOS yükleyicisini [nodejs.org](https://nodejs.org/) üzerinden indirin.
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
    
    Alternatif olarak bir sürüm yöneticisi kullanabilirsiniz (aşağıya bakın).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (önerilen):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    Ya da Windows yükleyicisini [nodejs.org](https://nodejs.org/) üzerinden indirin.
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  Sürüm yöneticileri, Node sürümleri arasında kolayca geçiş yapmanızı sağlar. Popüler seçenekler:

- [**fnm**](https://github.com/Schniz/fnm) — hızlı, çapraz platform
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux’te yaygın
- [**mise**](https://mise.jdx.dev/) — çok dilli (Node, Python, Ruby, vb.)

fnm ile örnek:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Sürüm yöneticinizin kabuk başlangıç dosyanızda (`~/.zshrc` veya `~/.bashrc`) başlatıldığından emin olun. Aksi halde, PATH Node’un bin dizinini içermeyeceği için yeni terminal oturumlarında `openclaw` bulunamayabilir.
  </Warning>
</Accordion>

## Sorun Giderme

### `openclaw: command not found`

Bu, neredeyse her zaman npm’in global bin dizininin PATH’inizde olmadığı anlamına gelir.

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
    Çıktıda `<npm-prefix>/bin`’yı (macOS/Linux) veya `<npm-prefix>`’yi (Windows) arayın.
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` veya `~/.bashrc` dosyasına ekleyin:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            Ardından yeni bir terminal açın (veya zsh’te `rehash`, bash’te `hash -r` çalıştırın).
          </Tab>
          <Tab title="Windows">
            `npm prefix -g` çıktısını Ayarlar → Sistem → Ortam Değişkenleri üzerinden sistem PATH’inize ekleyin.
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### `npm install -g` üzerinde izin hataları (Linux)

`EACCES` hataları görüyorsanız, npm’in global önekini kullanıcı tarafından yazılabilir bir dizine değiştirin:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Kalıcı olması için `export PATH=...` satırını `~/.bashrc` veya `~/.zshrc` dosyanıza ekleyin.
