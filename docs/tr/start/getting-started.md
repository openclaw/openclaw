---
summary: "OpenClaw'ı kurun ve ilk sohbetinizi dakikalar içinde çalıştırın."
read_when:
  - Sıfırdan ilk kurulum
  - Çalışan bir sohbete en hızlı yolu istiyorsunuz
title: "Başlarken"
---

# Başlarken

Amaç: minimum kurulumla sıfırdan çalışan ilk sohbete ulaşmak.

<Info>
En hızlı sohbet: Control UI'yi açın (kanal kurulumu gerekmez). `openclaw dashboard` çalıştırın
ve tarayıcıda sohbet edin ya da
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">gateway ana makinesi</Tooltip>üzerinde `http://127.0.0.1:18789/` açın.
Belgeler: [Dashboard](/web/dashboard) ve [Control UI](/web/control-ui).
</Info>

## Ön Koşullar

- Node 22 veya daha yeni

<Tip>
Emin değilseniz Node sürümünüzü `node --version` ile kontrol edin.
</Tip>

## Hızlı kurulum (CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
    <Tabs>
      <Tab title="macOS/Linux">
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

    ```
    <Note>
    Diğer yükleme yöntemleri ve gereksinimler: [Install](/install).
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    Sihirbaz; kimlik doğrulama, gateway ayarları ve isteğe bağlı kanalları yapılandırır.
    Ayrıntılar için [Onboarding Wizard](/start/wizard) sayfasına bakın.
    ```

  </Step>
  <Step title="Check the Gateway">
    Hizmeti yüklediyseniz, zaten çalışıyor olmalıdır:

    ````
    ```bash
    openclaw gateway status
    ```
    ````

  </Step>
  <Step title="Open the Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Control UI yükleniyorsa, Gateway'iniz kullanıma hazırdır.
</Check>

## İsteğe bağlı kontroller ve ekstralar

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    Hızlı testler veya sorun giderme için kullanışlıdır.

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    Yapılandırılmış bir kanal gerektirir.

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## Daha derine in

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Tam CLI sihirbaz başvurusu ve gelişmiş seçenekler.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    macOS uygulaması için ilk çalıştırma akışı.
  </Card>
</Columns>

## Neye sahip olacaksınız

- Çalışan bir Gateway
- Yapılandırılmış kimlik doğrulama
- Control UI erişimi veya bağlı bir kanal

## Sonraki adımlar

- DM güvenliği ve onaylar: [Pairing](/channels/pairing)
- Daha fazla kanal bağlayın: [Channels](/channels)
- Gelişmiş iş akışları ve kaynaktan kurulum: [Setup](/start/setup)
