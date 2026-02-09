---
summary: "OpenClaw için VPS barındırma merkezi (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Gateway'i bulutta çalıştırmak istiyorsanız
  - VPS/barındırma kılavuzlarının hızlı bir haritasına ihtiyacınız varsa
title: "VPS Barındırma"
---

# VPS barındırma

Bu merkez, desteklenen VPS/barındırma kılavuzlarına bağlantı verir ve bulut
dağıtımlarının üst düzeyde nasıl çalıştığını açıklar.

## Bir sağlayıcı seçin

- **Railway** (tek tık + tarayıcı üzerinden kurulum): [Railway](/install/railway)
- **Northflank** (tek tık + tarayıcı üzerinden kurulum): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — ayda $0 (Always Free, ARM; kapasite/kayıt bazen sorunlu olabilir)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS proxy): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: bu da iyi çalışır. Video kılavuzu:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Bulut kurulumları nasıl çalışır

- **Gateway VPS üzerinde çalışır** ve durum + çalışma alanına sahiptir.
- Dizüstü/telefonunuzdan **Control UI** veya **Tailscale/SSH** üzerinden bağlanırsınız.
- VPS’i doğruluk kaynağı olarak kabul edin ve durumu + çalışma alanını **yedekleyin**.
- Güvenli varsayılan: Gateway’i loopback üzerinde tutun ve SSH tüneli veya Tailscale Serve ile erişin.
  `lan`/`tailnet`’e bağlarsanız, `gateway.auth.token` veya `gateway.auth.password`’ü zorunlu kılın.

Uzaktan erişim: [Gateway remote](/gateway/remote)  
Platformlar merkezi: [Platforms](/platforms)

## VPS ile node kullanımı

Gateway’i bulutta tutabilir ve yerel cihazlarınızdaki **node**’ları
(Mac/iOS/Android/headless) eşleyebilirsiniz. Node’lar, Gateway bulutta kalırken
yerel ekran/kamera/tuval ve `system.run`
yeteneklerini sağlar.

Dokümanlar: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
