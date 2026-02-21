---
summary: "OpenClaw'ı kurup dakikalar içinde ilk sohbetini başlat."
read_when:
  - Sıfırdan ilk kurulum yapıyorsun
  - Çalışan bir sohbete en hızlı şekilde ulaşmak istiyorsun
title: "Başlangıç"
---

# Başlangıç

Hedef: minimum kurulumla sıfırdan çalışan ilk sohbete ulaşmak.

<Info>
En hızlı sohbet yolu: Control UI’ı aç (kanal kurulumu gerekmez). `openclaw dashboard`
komutunu çalıştırıp tarayıcıda sohbet edebilir veya
<Tooltip headline="Gateway host" tip="OpenClaw gateway servisinin çalıştığı makine.">gateway host</Tooltip>
üzerinde `http://127.0.0.1:18789/` adresini açabilirsin.
Dokümanlar: [Dashboard](/web/dashboard) ve [Control UI](/web/control-ui).
</Info>

## Ön koşullar

- Node 22 veya üzeri

<Tip>
Emin değilsen Node sürümünü `node --version` ile kontrol et.
</Tip>

## Hızlı kurulum (CLI)

<Steps>
  <Step title="OpenClaw'ı kur (önerilen)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="Kurulum Scripti Akışı"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Diğer kurulum yöntemleri ve gereksinimler: [Install](/install).
    </Note>

  </Step>
  <Step title="Onboarding sihirbazını çalıştır">
    ```bash
    openclaw onboard --install-daemon
    ```

    Sihirbaz auth, gateway ayarları ve opsiyonel kanalları yapılandırır.
    Detaylar için: [Onboarding Wizard](/start/wizard).

  </Step>
  <Step title="Gateway'i kontrol et">
    Servis kuruluysa zaten çalışıyor olmalı:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Control UI'ı aç">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Control UI açılıyorsa Gateway kullanıma hazırdır.
</Check>

## Opsiyonel kontroller ve ekstra adımlar

<AccordionGroup>
  <Accordion title="Gateway'i foreground'da çalıştır">
    Hızlı test ve troubleshooting için faydalıdır.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Test mesajı gönder">
    Yapılandırılmış bir kanal gerektirir.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Faydalı environment değişkenleri

OpenClaw'ı bir servis hesabı altında çalıştırıyorsan veya özel config/state yolları kullanmak istiyorsan:

- `OPENCLAW_HOME`: İç path çözümlemesinde kullanılan home dizinini belirler.
- `OPENCLAW_STATE_DIR`: State dizinini override eder.
- `OPENCLAW_CONFIG_PATH`: Config dosyası yolunu override eder.

Tam referans: [Environment vars](/help/environment).

## Daha derine in

<Columns>
  <Card title="Onboarding Wizard (detaylar)" href="/start/wizard">
    Tam CLI wizard referansı ve gelişmiş seçenekler.
  </Card>
  <Card title="macOS uygulaması onboarding" href="/start/onboarding">
    macOS uygulaması için ilk çalıştırma akışı.
  </Card>
</Columns>

## Elinde ne olacak

- Çalışan bir Gateway
- Yapılandırılmış auth
- Control UI erişimi veya bağlı bir kanal

## Sonraki adımlar

- DM güvenliği ve onaylar: [Pairing](/channels/pairing)
- Daha fazla kanal bağla: [Channels](/channels)
- Gelişmiş akışlar ve kaynak koddan kurulum: [Setup](/start/setup)
