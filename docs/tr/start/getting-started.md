---
summary: "OpenClaw'ı kurun ve ilk sohbetinizi dakikalar içinde çalıştırın."
read_when:
  - Sıfırdan ilk kurulum
  - Çalışan bir sohbete en hızlı yolu istiyorsunuz
title: "Başlarken"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:42Z
---

# Başlarken

Amaç: minimum kurulumla sıfırdan çalışan ilk sohbete ulaşmak.

<Info>
En hızlı sohbet: Control UI'yi açın (kanal kurulumu gerekmez). `openclaw dashboard` çalıştırın
ve tarayıcıda sohbet edin ya da
<Tooltip headline="Gateway host" tip="OpenClaw gateway hizmetini çalıştıran makine.">gateway ana makinesi</Tooltip> üzerinde `http://127.0.0.1:18789/` açın.
Belgeler: [Dashboard](/web/dashboard) ve [Control UI](/web/control-ui).
</Info>

## Ön koşullar

- Node 22 veya daha yeni

<Tip>
Emin değilseniz Node sürümünüzü `node --version` ile kontrol edin.
</Tip>

## Hızlı kurulum (CLI)

<Steps>
  <Step title="OpenClaw'ı yükleyin (önerilir)">
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

    <Note>
    Diğer yükleme yöntemleri ve gereksinimler: [Install](/install).
    </Note>

  </Step>
  <Step title="Onboarding sihirbazını çalıştırın">
    ```bash
    openclaw onboard --install-daemon
    ```

    Sihirbaz; kimlik doğrulama, gateway ayarları ve isteğe bağlı kanalları yapılandırır.
    Ayrıntılar için [Onboarding Wizard](/start/wizard) sayfasına bakın.

  </Step>
  <Step title="Gateway'i kontrol edin">
    Hizmeti yüklediyseniz, zaten çalışıyor olmalıdır:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Control UI'yi açın">
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
  <Accordion title="Gateway'i ön planda çalıştırın">
    Hızlı testler veya sorun giderme için kullanışlıdır.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Test mesajı gönderin">
    Yapılandırılmış bir kanal gerektirir.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Daha derine inin

<Columns>
  <Card title="Onboarding Wizard (ayrıntılar)" href="/start/wizard">
    Tam CLI sihirbaz başvurusu ve gelişmiş seçenekler.
  </Card>
  <Card title="macOS uygulaması onboarding" href="/start/onboarding">
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
