---
summary: "OpenClaw için ilk çalıştırma onboarding akışı (macOS uygulaması)"
read_when:
  - macOS onboarding asistanını tasarlarken
  - Kimlik doğrulama veya kimlik kurulumunu uygularken
title: "Onboarding (macOS Uygulaması)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:46Z
---

# Onboarding (macOS Uygulaması)

Bu belge, **mevcut** ilk çalıştırma onboarding akışını açıklar. Amaç,
sorunsuz bir “0. gün” deneyimidir: Gateway’in nerede çalışacağını seçmek,
kimlik doğrulamayı bağlamak, sihirbazı çalıştırmak ve ajanın kendi kendini
bootstrap etmesine izin vermek.

<Steps>
<Step title="macOS uyarısını onaylayın">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Yerel ağları bulmayı onaylayın">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Hoş geldiniz ve güvenlik bildirimi">
<Frame caption="Görüntülenen güvenlik bildirimini okuyun ve buna göre karar verin">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Yerel vs Uzak">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway** nerede çalışır?

- **Bu Mac (Yalnızca yerel):** onboarding, OAuth akışlarını çalıştırabilir ve
  kimlik bilgilerini yerel olarak yazabilir.
- **Uzak (SSH/Tailnet üzerinden):** onboarding, OAuth’u yerel olarak
  **çalıştırmaz**; kimlik bilgileri gateway ana makinesinde mevcut olmalıdır.
- **Daha sonra yapılandır:** kurulumu atlayın ve uygulamayı yapılandırılmamış
  bırakın.

<Tip>
**Gateway kimlik doğrulama ipucu:**
- Sihirbaz artık loopback için bile bir **token** üretir; bu nedenle yerel WS
  istemcilerinin kimlik doğrulaması gerekir.
- Kimlik doğrulamayı devre dışı bırakırsanız, herhangi bir yerel süreç
  bağlanabilir; bunu yalnızca tamamen güvenilen makinelerde kullanın.
- Çoklu makine erişimi veya loopback olmayan bağlamalar için bir **token**
  kullanın.
</Tip>
</Step>
<Step title="İzinler">
<Frame caption="OpenClaw’a hangi izinleri vermek istediğinizi seçin">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Onboarding, aşağıdakiler için gerekli TCC izinlerini ister:

- Otomasyon (AppleScript)
- Bildirimler
- Erişilebilirlik
- Ekran Kaydı
- Mikrofon
- Konuşma Tanıma
- Kamera
- Konum

</Step>
<Step title="CLI">
  <Info>Bu adım isteğe bağlıdır</Info>
  Uygulama, terminal iş akışlarının ve launchd görevlerinin kutudan çıktığı gibi
  çalışması için npm/pnpm üzerinden global `openclaw` CLI’yı kurabilir.
</Step>
<Step title="Onboarding Sohbeti (özel oturum)">
  Kurulumdan sonra uygulama, ajanın kendini tanıtabilmesi ve sonraki adımları
  yönlendirebilmesi için özel bir onboarding sohbet oturumu açar. Bu, ilk
  çalıştırma rehberliğini normal konuşmanızdan ayrı tutar.
  İlk ajan çalıştırması sırasında gateway ana makinesinde neler olduğunu görmek
  için [Bootstrapping](/start/bootstrapping) bölümüne bakın.
</Step>
</Steps>
