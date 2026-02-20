---
summary: "OpenClaw kurulum, yapılandırma ve kullanımına dair sık sorulan sorular"
title: "SSS (FAQ)"
---

# SSS (FAQ)

Gerçek dünyadaki kurulumlar için hızlı cevaplar + derin troubleshooting (lokal geliştirme, VPS, multi-agent, OAuth/API key, model failover).

- Runtime teşhisi için: [Troubleshooting](/gateway/troubleshooting)
- Tam config referansı için: [Configuration](/gateway/configuration)

> Not: Bu sayfa Türkçe SSS çevirisinin **başlangıç sürümüdür**. Kapsam, sonraki PR'larla genişletilecektir.

## İçindekiler

- İlk 60 saniyede kontrol listesi
- Hızlı kurulum ve ilk çalıştırma
- Gateway ve bağlantı
- Model, auth ve failover
- Daha fazla yardım

## İlk 60 saniyede kontrol listesi

1. **Hızlı durum kontrolü**

   ```bash
   openclaw status
   ```

   Yerel özet verir: OS, update, gateway/service erişimi, agent/session durumu.

2. **Paylaşılabilir rapor**

   ```bash
   openclaw status --all
   ```

   Salt-okunur teşhis çıktısı (hassas bilgiler redacted edilir).

3. **Daemon + port durumu**

   ```bash
   openclaw gateway status
   ```

   Supervisor runtime ile RPC erişilebilirliğini ayrı gösterir.

4. **Derin probelar**

   ```bash
   openclaw status --deep
   ```

   Gateway health + provider probe çalıştırır.

5. **Log takibi**

   ```bash
   openclaw logs --follow
   ```

---

## Hızlı kurulum ve ilk çalıştırma

### Takılırsam en hızlı toparlama yolu ne?

Sırayla şunları çalıştır:

```bash
openclaw status
openclaw doctor --non-interactive
openclaw gateway restart
```

Ardından tekrar test et.

### Önerilen kurulum yolu nedir?

Önerilen yol onboarding sihirbazıdır:

```bash
openclaw onboard --install-daemon
```

Bu akış auth + gateway + temel ayarları birlikte kurar.

### Onboarding sonrası dashboard nasıl açılır?

```bash
openclaw dashboard
```

veya gateway host üzerinde doğrudan:

`http://127.0.0.1:18789/`

### Hangi runtime gerekli?

Node.js 22+ önerilir.

---

## Gateway ve bağlantı

### `openclaw gateway status` neyi gösterir?

- Servis/daemon durumu
- RPC probe sonucu
- Dinlenen host/port
- Kullanılan config yolu

### "Runtime running ama RPC failed" neden olur?

En yaygın nedenler:

- Yanlış bind/port
- Yanlış token
- Eski bir gateway instance
- Farklı config dosyasının çalışması

Önce `openclaw gateway status`, sonra `openclaw logs --follow` bak.

### Control UI "unauthorized" diyorsa ne yapmalıyım?

- Token eşleşmesini kontrol et
- Gateway'in doğru config ile kalktığını doğrula
- Gerekirse gateway restart yap

---

## Model, auth ve failover

### Auth profile nedir?

Provider kimlik bilgisinin isimlendirilmiş kaydıdır (örn. `openai-codex:arif`, `anthropic:default`).

### OAuth ile API key farkı ne?

- **OAuth:** kullanıcı hesabı üzerinden yetkilendirme
- **API key:** elle sağlanan sabit anahtar

### "All models failed" görürsem ne yapmalıyım?

1. İlgili auth profile gerçekten var mı kontrol et
2. API key/token geçerli mi kontrol et
3. Fallback zincirini kontrol et
4. `openclaw status --deep` ile provider probe bak

---

## Daha fazla yardım

- Kanal dokümanları: [/channels](/channels)
- Kurulum: [/install](/install)
- Güvenlik: [/gateway/security](/gateway/security)
- Health: [/gateway/health](/gateway/health)

---

## Çeviri notu

Bu dosya, İngilizce `help/faq.md` içeriğinin Türkçe başlangıç sürümüdür.
Kapsamı adım adım artırmak için sonraki PR'larda yeni bölümler eklenecektir.
