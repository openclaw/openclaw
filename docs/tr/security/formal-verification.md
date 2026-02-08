---
title: Biçimsel Doğrulama (Güvenlik Modelleri)
summary: OpenClaw’ın en yüksek riskli yolları için makine tarafından doğrulanmış güvenlik modelleri.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:54Z
---

# Biçimsel Doğrulama (Güvenlik Modelleri)

Bu sayfa, OpenClaw’ın **biçimsel güvenlik modellerini** (bugün TLA+/TLC; gerektiğinde daha fazlası) izler.

> Not: bazı eski bağlantılar önceki proje adına referans verebilir.

**Amaç (kuzey yıldızı):** açık varsayımlar altında, OpenClaw’ın amaçlanan güvenlik politikasını (yetkilendirme, oturum yalıtımı, araç geçitleme ve yanlış yapılandırma güvenliği) uyguladığını gösteren, makine tarafından doğrulanmış bir argüman sağlamak.

**Bu nedir (bugün):** yürütülebilir, saldırgan güdümlü bir **güvenlik regresyon paketi**:

- Her iddia, sonlu bir durum uzayı üzerinde çalıştırılabilir bir model denetimine sahiptir.
- Birçok iddia, gerçekçi bir hata sınıfı için karşı-örnek izi üreten eşlenik bir **negatif model** ile birlikte gelir.

**Bu ne değildir (henüz):** “OpenClaw her bakımdan güvenlidir” şeklinde bir kanıt ya da tüm TypeScript uygulamasının doğru olduğuna dair bir ispat.

## Modeller nerede bulunur

Modeller ayrı bir depoda tutulur: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Önemli uyarılar

- Bunlar **modeldir**, tam TypeScript uygulaması değildir. Model ile kod arasında sapma mümkündür.
- Sonuçlar, TLC tarafından keşfedilen durum uzayı ile sınırlıdır; “yeşil” olmak, modellenen varsayımlar ve sınırlar dışında güvenliği ima etmez.
- Bazı iddialar açık çevresel varsayımlara dayanır (örn. doğru dağıtım, doğru yapılandırma girdileri).

## Sonuçların yeniden üretilmesi

Bugün sonuçlar, modeller deposunun yerel olarak klonlanması ve TLC’nin çalıştırılmasıyla yeniden üretilir (aşağıya bakın). Gelecekteki bir yineleme şunları sunabilir:

- Herkese açık çıktılarla (karşı-örnek izleri, çalışma günlükleri) CI üzerinde çalıştırılan modeller
- Küçük, sınırlı denetimler için barındırılan bir “bu modeli çalıştır” iş akışı

Başlarken:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway (Ağ Geçidi) maruziyeti ve açık gateway yanlış yapılandırması

**İddia:** kimlik doğrulama olmadan local loopback ötesine bağlama, uzaktan ele geçirilme olasılığını mümkün kılabilir / maruziyeti artırır; belirteç/parola, (model varsayımlarına göre) yetkisiz saldırganları engeller.

- Yeşil çalıştırmalar:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Kırmızı (beklenen):
  - `make gateway-exposure-v2-negative`

Ayrıca bakınız: modeller deposunda `docs/gateway-exposure-matrix.md`.

### Nodes.run hattı (en yüksek riskli yetenek)

**İddia:** `nodes.run` için (a) düğüm komut izin listesi ve bildirilmiş komutlar ile (b) yapılandırıldığında canlı onay gerekir; onaylar (modelde) yeniden oynatmayı önlemek için belirteçlidir.

- Yeşil çalıştırmalar:
  - `make nodes-pipeline`
  - `make approvals-token`
- Kırmızı (beklenen):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Eşleştirme deposu (DM geçitleme)

**İddia:** eşleştirme istekleri TTL ve bekleyen istek üst sınırlarına uyar.

- Yeşil çalıştırmalar:
  - `make pairing`
  - `make pairing-cap`
- Kırmızı (beklenen):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Giriş geçitleme (bahsetmeler + kontrol-komutu atlatma)

**İddia:** bahsetme gerektiren grup bağlamlarında, yetkisiz bir “kontrol komutu” bahsetme geçitlemesini atlayamaz.

- Yeşil:
  - `make ingress-gating`
- Kırmızı (beklenen):
  - `make ingress-gating-negative`

### Yönlendirme/oturum-anahtarı yalıtımı

**İddia:** farklı eşlerden gelen DM’ler, açıkça bağlanmadıkça/yapılandırılmadıkça aynı oturuma çökmemelidir.

- Yeşil:
  - `make routing-isolation`
- Kırmızı (beklenen):
  - `make routing-isolation-negative`

## v1++: ek sınırlı modeller (eşzamanlılık, yeniden denemeler, iz doğruluğu)

Bunlar, gerçek dünya hata kipleri (atomik olmayan güncellemeler, yeniden denemeler ve mesaj fan-out’u) etrafında doğruluğu sıkılaştıran takip modelleridir.

### Eşleştirme deposu eşzamanlılığı / idempotans

**İddia:** bir eşleştirme deposu, iç içe geçmeler altında bile `MaxPending` ve idempotansı sağlamalıdır (yani “kontrol-et-then-yaz” atomik/ kilitli olmalıdır; yenileme kopyalar oluşturmamalıdır).

Anlamı:

- Eşzamanlı istekler altında, bir kanal için `MaxPending` aşılamaz.
- Aynı `(channel, sender)` için tekrarlanan istekler/yenilemeler, yinelenen canlı bekleyen satırlar oluşturmamalıdır.

- Yeşil çalıştırmalar:
  - `make pairing-race` (atomik/kilitli üst sınır kontrolü)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Kırmızı (beklenen):
  - `make pairing-race-negative` (atomik olmayan begin/commit üst sınır yarışı)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Giriş iz korelasyonu / idempotans

**İddia:** alım (ingestion), fan-out boyunca iz korelasyonunu korumalı ve sağlayıcı yeniden denemeleri altında idempotan olmalıdır.

Anlamı:

- Tek bir harici olay birden fazla dahili mesaja dönüştüğünde, her parça aynı iz/olay kimliğini korur.
- Yeniden denemeler çift işlenmeye yol açmaz.
- Sağlayıcı olay kimlikleri yoksa, ayırt etme (dedupe) farklı olayların düşmesini önlemek için güvenli bir anahtara (örn. iz kimliği) geri döner.

- Yeşil:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Kırmızı (beklenen):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Yönlendirme dmScope önceliği + identityLinks

**İddia:** yönlendirme, DM oturumlarını varsayılan olarak yalıtılmış tutmalı ve yalnızca açıkça yapılandırıldığında oturumları birleştirmelidir (kanal önceliği + kimlik bağlantıları).

Anlamı:

- Kanal-özel dmScope geçersiz kılmaları, küresel varsayılanlara üstün gelmelidir.
- identityLinks, yalnızca açıkça bağlanmış gruplar içinde birleştirmeli; ilişkisiz eşler arasında birleştirmemelidir.

- Yeşil:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Kırmızı (beklenen):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
