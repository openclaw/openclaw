---
summary: "OpenClaw’un istem bağlamını nasıl oluşturduğunu ve belirteç kullanımını + maliyetleri nasıl raporladığını açıklar"
read_when:
  - Belirteç kullanımını, maliyetleri veya bağlam pencerelerini açıklarken
  - Bağlam büyümesini veya sıkıştırma davranışını hata ayıklarken
title: "Belirteç Kullanımı ve Maliyetler"
---

# Belirteç kullanımı ve maliyetler

OpenClaw, karakterleri değil **belirteçleri (token)** izler. Belirteçler modele özgüdür, ancak
OpenAI tarzı modellerin çoğu İngilizce metin için belirteç başına ortalama ~4 karaktere sahiptir.

## Sistem istemi nasıl oluşturulur

OpenClaw her çalıştırmada kendi sistem istemini oluşturur. Şunları içerir:

- Araç listesi + kısa açıklamalar
- Skills listesi (yalnızca meta veriler; talimatlar `read` ile talep üzerine yüklenir)
- Kendi kendini güncelleme talimatları
- Çalışma alanı + önyükleme dosyaları (yeniyse `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`). Büyük dosyalar `agents.defaults.bootstrapMaxChars` tarafından kısaltılır (varsayılan: 20000).
- Zaman (UTC + kullanıcı saat dilimi)
- Yanıt etiketleri + heartbeat davranışı
- Çalışma zamanı meta verileri (ana makine/OS/model/düşünme)

Tam döküm için [System Prompt](/concepts/system-prompt) bölümüne bakın.

## Bağlam penceresinde neler sayılır

Modelin aldığı her şey bağlam sınırına dahil edilir:

- Sistem istemi (yukarıda listelenen tüm bölümler)
- Konuşma geçmişi (kullanıcı + asistan mesajları)
- Araç çağrıları ve araç sonuçları
- Ekler/dökümler (görseller, ses, dosyalar)
- Sıkıştırma özetleri ve budama artefaktları
- Sağlayıcı sarmalayıcıları veya güvenlik başlıkları (görünmez, ancak yine de sayılır)

Pratik bir döküm için (enjekte edilen dosya başına, araçlar, skills ve sistem istemi boyutu),
`/context list` veya `/context detail` kullanın. [Context](/concepts/context) bölümüne bakın.

## Mevcut belirteç kullanımını nasıl görürsünüz

Sohbette şunları kullanın:

- `/status` → oturum modeli, bağlam kullanımı,
  son yanıtın giriş/çıkış belirteçleri ve **tahmini maliyeti** (yalnızca API anahtarı) içeren **emoji ağırlıklı durum kartı**.
- `/usage off|tokens|full` → her yanıta **yanıt başına kullanım alt bilgisi** ekler.
  - Oturum başına kalıcıdır (`responseUsage` olarak saklanır).
  - OAuth kimlik doğrulaması **maliyeti gizler** (yalnızca belirteçler).
- `/usage cost` → OpenClaw oturum günlüklerinden yerel bir maliyet özeti gösterir.

Diğer yüzeyler:

- **TUI/Web TUI:** `/status` + `/usage` desteklenir.
- **CLI:** `openclaw status --usage` ve `openclaw channels list`,
  sağlayıcı kota pencerelerini gösterir (yanıt başına maliyetler değil).

## Maliyet tahmini (gösterildiğinde)

Maliyetler, model fiyatlandırma yapılandırmanızdan tahmin edilir:

```
models.providers.<provider>.models[].cost
```

Bunlar `input`, `output`, `cacheRead` ve
`cacheWrite` için **1M belirteç başına USD**’dir. Fiyatlandırma eksikse,
OpenClaw yalnızca belirteçleri gösterir. OAuth belirteçleri
asla dolar maliyetini göstermez.

## Önbellek TTL’i ve budamanın etkisi

Sağlayıcı istem önbelleklemesi yalnızca önbellek TTL penceresi içinde geçerlidir. OpenClaw
isteğe bağlı olarak **cache-ttl pruning** çalıştırabilir: önbellek TTL’i
sona erdiğinde oturumu budar, ardından önbellek penceresini sıfırlar; böylece
sonraki istekler, tüm geçmişi yeniden önbelleğe almak yerine taze önbelleğe
alınmış bağlamı yeniden kullanabilir. Bu, bir oturum TTL’i aşacak şekilde boşta
kaldığında önbellek yazma maliyetlerini düşük tutar.

Bunu [Gateway yapılandırması](/gateway/configuration) içinde ayarlayın ve
davranış ayrıntıları için [Session pruning](/concepts/session-pruning) bölümüne bakın.

Heartbeat, boşta kalma aralıkları boyunca önbelleği **sıcak** tutabilir. Modelinizin
önbellek TTL’i `1h` ise, heartbeat aralığını bunun biraz altına
(ör. `55m`) ayarlamak, tüm istemin yeniden önbelleğe alınmasını
önleyerek önbellek yazma maliyetlerini azaltabilir.

Anthropic API fiyatlandırmasında, önbellek okumaları giriş belirteçlerine göre
çok daha ucuzdur; önbellek yazmaları ise daha yüksek bir çarpanla ücretlendirilir. En güncel oranlar ve TTL çarpanları için Anthropic’in istem önbellekleme
fiyatlandırmasına bakın:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Örnek: heartbeat ile 1 saatlik önbelleği sıcak tutma

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Belirteç baskısını azaltmaya yönelik ipuçları

- Uzun oturumları özetlemek için `/compact` kullanın.
- İş akışlarınızda büyük araç çıktıları kırpın.
- Skill açıklamalarını kısa tutun (skill listesi isteme enjekte edilir).
- Ayrıntılı, keşif amaçlı çalışmalar için daha küçük modelleri tercih edin.

Tam skill listesi ek yükü formülü için [Skills](/tools/skills) bölümüne bakın.
