---
summary: "Yükleyici betiklerinin nasıl çalıştığı (install.sh, install-cli.sh, install.ps1), bayraklar ve otomasyon"
read_when:
  - "`openclaw.ai/install.sh` dosyasını anlamak istiyorsanız"
  - Kurulumları otomatikleştirmek istiyorsanız (CI / başsız)
  - Bir GitHub checkout’undan kurulum yapmak istiyorsanız
title: "Yükleyici İç Yapısı"
---

# Yükleyici iç yapısı

OpenClaw, `openclaw.ai` üzerinden sunulan üç yükleyici betikle birlikte gelir.

| ```
Git yoksa kurar.
```           | Platform                                | Ne yapar                                                                                                                                |
| ---------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | Gerekirse Node’u kurar, OpenClaw’ı npm (varsayılan) veya git ile kurar ve onboarding çalıştırabilir. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | Node + OpenClaw’ı yerel bir önek altına kurar (`~/.openclaw`). Root gerekmez.        |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Gerekirse Node’u kurar, OpenClaw’ı npm (varsayılan) veya git ile kurar ve onboarding çalıştırabilir. |

## Hızlı komutlar

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
Kurulum başarılı olur ancak yeni bir terminalde `openclaw` bulunamazsa, [Node.js sorun giderme](/install/node#troubleshooting) bölümüne bakın.
</Note>

---

## install.sh

<Tip>
macOS/Linux/WSL üzerinde çoğu etkileşimli kurulum için önerilir.
</Tip>

### Akış (install.sh)

<Steps>
  <Step title="Detect OS">
    macOS ve Linux’u (WSL dahil) destekler. macOS algılanırsa, eksikse Homebrew kurar.
  </Step>
  <Step title="Ensure Node.js 22+">
    Node sürümünü denetler ve gerekirse Node 22’yi kurar (macOS’ta Homebrew, Linux’ta NodeSource kurulum betikleri ile apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    npm ile `--prefix </Step>
  <Step title="Install OpenClaw">
    - `npm` yöntemi (varsayılan): global npm kurulumu
    - `git` yöntemi: depoyu klonla/güncelle, pnpm ile bağımlılıkları kur, derle, ardından sarmalayıcıyı `~/.local/bin/openclaw` konumuna kur
  </Step>
  <Step title="Post-install tasks">
    - Yükseltmelerde ve git kurulumlarında `openclaw doctor --non-interactive` çalıştırır (en iyi çaba)
    - Uygun olduğunda onboarding’i dener (TTY mevcut, onboarding devre dışı değil ve bootstrap/yapılandırma kontrolleri geçer)
    - Varsayılan olarak `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Kaynak checkout algılama

Bir OpenClaw checkout’ı içinde çalıştırılırsa (`package.json` + `pnpm-workspace.yaml`), betik şunları sunar:

- checkout’ı kullan (`git`), veya
- global kurulumu kullan (`npm`)

TTY yoksa ve bir kurulum yöntemi ayarlanmadıysa, varsayılan olarak `npm` seçilir ve uyarı verilir.

Geçersiz yöntem seçimi veya geçersiz `--install-method` değerleri için betik `2` koduyla çıkar.

### Örnekler (install.sh)

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

| Bayrak                            | Açıklama                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | Kurulum yöntemini seç (varsayılan: `npm`). Takma ad: `--method` |
| `--npm`                           | npm yöntemi için kısayol                                                                                                           |
| `--git`                           | git yöntemi için kısayol. Takma ad: `--github`                                                     |
| `--version <version\\|dist-tag>` | npm sürümü veya dist-tag (varsayılan: `latest`)                                                 |
| `--beta`                          | Varsa beta dist-tag’i kullan, aksi halde `latest`’a geri dön                                                                       |
| `--git-dir <path>`                | Checkout dizini (varsayılan: `~/openclaw`). Takma ad: `--dir`   |
| `--no-git-update`                 | Mevcut checkout için `git pull`’i atla                                                                                             |
| `--no-prompt`                     | İstemleri devre dışı bırak                                                                                                         |
| `--no-onboard`                    | Onboarding’i atla                                                                                                                  |
| `--onboard`                       | Onboarding’i etkinleştir                                                                                                           |
| `--dry-run`                       | Değişiklik uygulamadan eylemleri yazdır                                                                                            |
| `--verbose`                       | Hata ayıklama çıktısını etkinleştir (`set -x`, npm notice-level günlükleri)                                     |
| `--help`                          | Kullanımı göster (`-h`)                                                                                         |

  </Accordion>

  <Accordion title="Environment variables reference">

| Değişken                                        | Açıklama                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | Kurulum yöntemi                                                                        |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | npm sürümü veya dist-tag                                                               |
| `OPENCLAW_BETA=0\\|1`                          | Varsa beta’yı kullan                                                                   |
| `OPENCLAW_GIT_DIR=<path>`                       | Checkout dizini                                                                        |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | git güncellemelerini aç/kapat                                                          |
| `OPENCLAW_NO_PROMPT=1`                          | İstemleri devre dışı bırak                                                             |
| `OPENCLAW_NO_ONBOARD=1`                         | Onboarding’i atla                                                                      |
| `OPENCLAW_DRY_RUN=1`                            | Dry run modu                                                                           |
| `OPENCLAW_VERBOSE=1`                            | Hata ayıklama modu                                                                     |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm günlük düzeyi                                                                      |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | sharp/libvips davranışını denetle (varsayılan: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Her şeyin yerel bir önek altında olmasını (varsayılan `~/.openclaw`) ve sistem Node bağımlılığı olmamasını istediğiniz ortamlar için tasarlanmıştır.
</Info>

### Akış (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Node tarball’unu (varsayılan `22.22.0`) `<prefix>/tools/node-v<version>` konumuna indirir ve SHA-256’yı doğrular.
  </Step>
  <Step title="Ensure Git">
    Git yoksa, Linux’ta apt/dnf/yum veya macOS’ta Homebrew ile kurmayı dener.
  </Step>
  <Step title="Install OpenClaw under prefix">`, kullanarak kurar, ardından sarmalayıcıyı `<prefix>Tanıtımı atla (varsayılan)<prefix>/bin/openclaw` konumuna yazar.
  </Step>
</Steps>

### Örnekler (install-cli.sh)

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

| Bayrak                 | Açıklama                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Kurulum öneki (varsayılan: `~/.openclaw`)            |
| `--version <ver>`      | OpenClaw sürümü veya dist-tag (varsayılan: `latest`) |
| `--node-version <ver>` | Node sürümü (varsayılan: `22.22.0`)                  |
| `--json`               | NDJSON olayları üret                                                                    |
| `--onboard`            | Kurulumdan sonra `openclaw onboard` çalıştır                                            |
| `--no-onboard`         | Skip onboarding (default)                                            |
| `--set-npm-prefix`     | Linux’ta, mevcut önek yazılabilir değilse npm önekini `~/.npm-global`’ye zorla          |
| `--help`               | Kullanımı göster (`-h`)                                              |

  </Accordion>

  <Accordion title="Environment variables reference">

| Değişken                                        | Açıklama                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | Kurulum öneki                                                                                               |
| `OPENCLAW_VERSION=<ver>`                        | OpenClaw sürümü veya dist-tag                                                                               |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Node sürümü                                                                                                 |
| `OPENCLAW_NO_ONBOARD=1`                         | Onboarding’i atla                                                                                           |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm günlük düzeyi                                                                                           |
| `OPENCLAW_GIT_DIR=<path>`                       | Eski temizlik arama yolu (eski `Peekaboo` alt modül checkout’ı kaldırılırken kullanılır) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | sharp/libvips davranışını denetle (varsayılan: `1`)                      |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Akış (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    PowerShell 5+ gerektirir.
  </Step>
  <Step title="Ensure Node.js 22+">
    If missing, attempts install via winget, then Chocolatey, then Scoop.
  </Step>
  <Step title="Install OpenClaw">
    - `npm` yöntemi (varsayılan): seçilen `-Tag` kullanılarak global npm kurulumu
    - `git` yöntemi: depoyu klonla/güncelle, pnpm ile kur/derle ve sarmalayıcıyı `%USERPROFILE%\.local\bin\openclaw.cmd` konumuna kur
  </Step>
  <Step title="Post-install tasks">
    Mümkün olduğunda gerekli bin dizinini kullanıcı PATH’ine ekler, ardından yükseltmelerde ve git kurulumlarında `openclaw doctor --non-interactive` çalıştırır (en iyi çaba).
  </Step>
</Steps>

### Örnekler (install.ps1)

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

| Bayrak                      | Açıklama                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `-InstallMethod npm\\|git` | Kurulum yöntemi (varsayılan: `npm`)                     |
| `-Tag <tag>`                | npm dist-tag (varsayılan: `latest`)                     |
| `-GitDir <path>`            | Checkout dizini (varsayılan: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | Onboarding’i atla                                                                          |
| `-NoGitUpdate`              | `git pull`’i atla                                                                          |
| `-DryRun`                   | Yalnızca eylemleri yazdır                                                                  |

  </Accordion>

  <Accordion title="Environment variables reference">

| Değişken                             | Açıklama                    |
| ------------------------------------ | --------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | Kurulum yöntemi             |
| `OPENCLAW_GIT_DIR=<path>`            | Checkout dizini             |
| `OPENCLAW_NO_ONBOARD=1`              | Onboarding’i atla           |
| `OPENCLAW_GIT_UPDATE=0`              | git pull’u devre dışı bırak |
| `OPENCLAW_DRY_RUN=1`                 | Dry run modu                |

  </Accordion>
</AccordionGroup>

<Note>
`-InstallMethod git` kullanılır ve Git eksikse, betik çıkar ve Git for Windows bağlantısını yazdırır.
</Note>

---

## CI ve otomasyon

Öngörülebilir çalıştırmalar için etkileşimsiz bayraklar/ortam değişkenleri kullanın.

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

## Sorun Giderme

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git, `git` kurulum yöntemi için gereklidir. `npm` kurulumlarında da, bağımlılıkların git URL’leri kullandığında `spawn git ENOENT` hatalarını önlemek için Git yine denetlenir/kurulur.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    Bazı Linux kurulumları npm global önekini root’a ait yollara işaret eder. `install.sh`, öneki `~/.npm-global`’ye değiştirebilir ve PATH dışa aktarımlarını kabuk rc dosyalarına ekleyebilir (bu dosyalar mevcutsa).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    Betikler, sharp’ın sistem libvips’e karşı derlenmesini önlemek için varsayılan olarak `SHARP_IGNORE_GLOBAL_LIBVIPS=1` ayarlar. Geçersiz kılmak için:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Git for Windows’u kurun, PowerShell’i yeniden açın, yükleyiciyi yeniden çalıştırın.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    `npm config get prefix` çalıştırın, `\bin` ekleyin, bu dizini kullanıcı PATH’ine ekleyin, ardından PowerShell’i yeniden açın.
  </Accordion>

  <Accordion title="openclaw not found after install">
    Genellikle bir PATH sorunudur. [Node.js sorun giderme](/install/node#troubleshooting) bölümüne bakın.
  </Accordion>
</AccordionGroup>
