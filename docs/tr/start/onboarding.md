---
summary: "OpenClaw için ilk çalıştırma onboarding akışı (macOS uygulaması)"
read_when:
  - macOS onboarding asistanını tasarlarken
  - Kimlik doğrulama veya kimlik kurulumunu uygularken
title: "Onboarding (macOS Uygulaması)"
sidebarTitle: "Onboarding: macOS App"
---

# Onboarding (macOS Uygulaması)

Bu belge, **mevcut** ilk çalıştırma onboarding akışını açıklar. Amaç,
sorunsuz bir “0. gün” deneyimidir: Gateway’in nerede çalışacağını seçmek,
kimlik doğrulamayı bağlamak, sihirbazı çalıştırmak ve ajanın kendi kendini
bootstrap etmesine izin vermek.

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="Görüntülenen güvenlik bildirimini okuyun ve buna göre karar verin">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
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
<Step title="Permissions">
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
<Step title="Onboarding Chat (dedicated session)">
  Kurulumdan sonra uygulama, ajanın kendini tanıtabilmesi ve sonraki adımları
  yönlendirebilmesi için özel bir onboarding sohbet oturumu açar. Bu, ilk
  çalıştırma rehberliğini normal konuşmanızdan ayrı tutar. İlk ajan çalıştırması sırasında gateway ana makinesinde neler olduğunu görmek
  için [Bootstrapping](/start/bootstrapping) bölümüne bakın.
</Step>
</Steps>
