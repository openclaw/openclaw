---
summary: "OpenClaw'ı kurun — yükleyici betiği, npm/pnpm, kaynaktan, Docker ve daha fazlası"
read_when:
  - Başlarken hızlı başlangıcı dışında bir kurulum yöntemine ihtiyacınız var
  - Bir bulut platformuna dağıtım yapmak istiyorsunuz
  - Güncelleme, taşıma veya kaldırma yapmanız gerekiyor
title: "Kurulum"
---

# Kurulum

[Başlarken](/start/getting-started) adımını zaten tamamladınız mı? Hazırsınız — bu sayfa alternatif kurulum yöntemleri, platforma özgü talimatlar ve bakım içindir.

## Sistem gereksinimleri

- **[Node 22+](/install/node)** (eksikse [yükleyici betiği](#install-methods) kurar)
- macOS, Linux veya Windows
- ```
  CLI’yi indirir, npm ile global olarak kurar ve tanıtım sihirbazını başlatır.
  ```

<Note>
Windows'ta OpenClaw'ı [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) altında çalıştırmanızı önemle öneririz.
</Note>

## Kurulum yöntemleri

<Tip>
**Yükleyici betiği**, OpenClaw'ı kurmanın önerilen yoludur. Node algılama, kurulum ve ilk katılımı tek adımda gerçekleştirir.
</Tip>

<AccordionGroup>
  <Accordion title="Installer script" icon="rocket" defaultOpen>Betik

    ```
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
    
    Hepsi bu — betik Node algılama, kurulum ve ilk katılımı yönetir.
    
    İlk katılımı atlayıp yalnızca ikiliyi kurmak için:
    
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
    
    Tüm bayraklar, ortam değişkenleri ve CI/otomasyon seçenekleri için [Yükleyici iç detayları](/install/installer) sayfasına bakın.
    ```

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Zaten Node 22+ yüklüyse ve kurulumu kendiniz yönetmek istiyorsanız:

    ```
    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```
    
        <Accordion title="sharp derleme hataları mı?">
          libvips'i küresel olarak kuruluysa (macOS'ta Homebrew ile yaygındır) ve `sharp` başarısız oluyorsa, önceden derlenmiş ikilileri zorlayın:
    
          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```
    
          `sharp: Please add node-gyp to your dependencies` görürseniz, ya derleme araçlarını kurun (macOS: Xcode CLT + `npm install -g node-gyp`) ya da yukarıdaki ortam değişkenini kullanın.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```
    
        <Note>
        pnpm, derleme betikleri olan paketler için açık onay gerektirir. İlk kurulumda "Ignored build scripts" uyarısı göründükten sonra `pnpm approve-builds -g` komutunu çalıştırın ve listelenen paketleri seçin.
        </Note>
      </Tab>
    </Tabs>
    ```

  </Accordion>

  <Accordion title="From source" icon="github">
    Katkıda bulunanlar veya yerel bir kopyadan çalıştırmak isteyen herkes için.

    ```
    <Steps>
      <Step title="Klonla ve derle">
        [OpenClaw deposunu](https://github.com/openclaw/openclaw) klonlayın ve derleyin:
    
        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="CLI'yi bağla">
        `openclaw` komutunu küresel olarak kullanılabilir yapın:
    
        ```bash
        pnpm link --global
        ```
    
        Alternatif olarak, bağlantıyı atlayıp komutları depo içinden `pnpm openclaw ...` ile çalıştırabilirsiniz.
      </Step>
      <Step title="İlk katılımı çalıştır">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>
    
    Daha derin geliştirme iş akışları için [Kurulum](/start/setup) sayfasına bakın.
    ```

  </Accordion>
</AccordionGroup>

## Diğer kurulum yöntemleri

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Konteynerleştirilmiş veya başsız dağıtımlar.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nix ile bildirime dayalı kurulum.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Otomatik filo sağlama.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bun çalışma zamanı üzerinden yalnızca CLI kullanımı.
  </Card>
</CardGroup>

## Kurulumdan sonra

Her şeyin çalıştığını doğrulayın:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Sorun Giderme: `openclaw` bulunamadı

<Accordion title="PATH diagnosis and fix">
  Hızlı tanı:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

`$(npm prefix -g)/bin` (macOS/Linux) veya `$(npm prefix -g)` (Windows) **PATH**'inizde (`$PATH`) değilse, kabuğunuz küresel npm ikililerini ( `openclaw` dahil) bulamaz.

Düzeltme — kabuk başlangıç dosyanıza (`~/.zshrc` veya `~/.bashrc`) ekleyin:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windows'ta, `npm prefix -g` çıktısını PATH'inize ekleyin.

Ardından yeni bir terminal açın (veya zsh'te `rehash` / bash'te `hash -r`). </Accordion>

## Güncelleme / kaldırma

<CardGroup cols={3}>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    OpenClaw'ı güncel tutun.
  </Card>
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">
    Yeni bir makineye geçin.
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    OpenClaw'ı tamamen kaldırın.
  </Card>
</CardGroup>
