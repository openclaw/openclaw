---
summary: "OpenClaw için VPS barındırma hub'ı (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Gateway'i bulutta çalıştırmak istiyorsanız
  - VPS/barındırma kılavuzlarının hızlı bir haritasına ihtiyacınız varsa
title: "VPS Barındırma"
---

# VPS barındırma

Bu hub, desteklenen VPS/barındırma kılavuzlarına bağlantı verir ve bulut dağıtımlarının üst düzeyde nasıl çalıştığını açıklar.

## Bir sağlayıcı seçin

- **Railway** (tek tıklama + tarayıcı kurulumu): [Railway](/install/railway)
- **Northflank** (tek tıklama + tarayıcı kurulumu): [Northflank](/install/northflank)
- **Oracle Cloud (Her Zaman Ücretsiz)**: [Oracle](/platforms/oracle) — $0/ay (Her Zaman Ücretsiz, ARM; kapasite/kayıt zor olabilir)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS proxy): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/ücretsiz katman)**: oldukça iyi çalışıyor. Video kılavuzu:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Bulut kurulumları nasıl çalışır

- **Gateway VPS'te çalışır** ve durum + çalışma alanına sahiptir.
- Dizüstü bilgisayarınızdan/telefonunuzdan **Control UI** veya **Tailscale/SSH** üzerinden bağlanırsınız.
- VPS'i kaynak olarak kabul edin ve durum + çalışma alanını **yedekleyin**.
- Güvenli varsayılan: Gateway'i loopback'te tutun ve SSH tüneli veya Tailscale Serve üzerinden erişin.
  `lan`/`tailnet`'e bağlarsanız, `gateway.auth.token` veya `gateway.auth.password` gerektirin.

Uzaktan erişim: [Gateway uzaktan erişim](/gateway/remote)  
Platformlar hub'ı: [Platformlar](/platforms)

## VPS'te paylaşılan şirket ajanı

Bu, kullanıcılar bir güven sınırı içindeyse (örneğin bir şirket ekibi) ve ajan yalnızca iş içinse geçerli bir kurulumdur.

- Ayrılmış bir runtime'da tutun (VPS/VM/konteyner + ayrılmış OS kullanıcı/hesapları).
- Bu runtime'da kişisel Apple/Google hesaplarınızda veya kişisel tarayıcı/parola yöneticisi profillerinizde oturum açmayın.
- Kullanıcılar birbirine düşmanlarsa, gateway/host/OS kullanıcısına göre bölün.

Güvenlik modeli detayları: [Güvenlik](/gateway/security)

## VPS ile node'ları kullanma

Gateway'i bulutta tutabilir ve yerel cihazlarınızda **node'ları eşleştirebilirsiniz** (Mac/iOS/Android/headless). Node'lar yerel ekran/kanvas ve `system.run` sağlar
