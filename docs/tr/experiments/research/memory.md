---
summary: "Araştırma notları: Clawd çalışma alanları için çevrimdışı bellek sistemi (Markdown tek gerçek kaynak + türetilmiş indeks)"
read_when:
  - Günlük Markdown günlüklerinin ötesinde çalışma alanı belleği (~/.openclaw/workspace) tasarlarken
  - Deciding: "Karar verirken: bağımsız CLI mi yoksa OpenClaw ile derin entegrasyon mu"
  - Çevrimdışı geri çağırma + yansıtma eklerken (retain/recall/reflect)
title: "Çalışma Alanı Belleği Araştırması"
---

# Workspace Memory v2 (offline): araştırma notları

Hedef: Clawd tarzı bir çalışma alanı (`agents.defaults.workspace`, varsayılan `~/.openclaw/workspace`); burada “bellek”, günlük başına bir Markdown dosyası (`memory/YYYY-MM-DD.md`) ve küçük bir dizi kararlı dosya (örn. `memory.md`, `SOUL.md`) olarak saklanır.

Bu belge, Markdown’ı gözden geçirilebilir ve kanonik tek gerçek kaynak olarak koruyan, ancak türetilmiş bir indeks aracılığıyla **yapılandırılmış geri çağırma** (arama, varlık özetleri, güven güncellemeleri) ekleyen **offline-first** bir bellek mimarisi önerir.

## Neden değiştirelim?

Mevcut kurulum (günlük başına bir dosya) şu konularda mükemmeldir:

- “append-only” günlük tutma
- insan tarafından düzenleme
- git destekli dayanıklılık + denetlenebilirlik
- düşük sürtünmeli yakalama (“sadece yaz”)

It’s weak for:

- yüksek geri çağırma gerektiren erişim (“X hakkında neye karar vermiştik?”, “Y’yi en son ne zaman denedik?”)
- çok sayıda dosyayı yeniden okumadan varlık merkezli yanıtlar (“Alice / The Castle / warelay hakkında anlat”)
- görüş/tercihlerin istikrarı (ve değiştiğinde kanıt)
- zaman kısıtları (“Kasım 2025’te ne doğruydu?”) ve çakışma çözümü

## Tasarım hedefleri

- **Offline**: ağ olmadan çalışır; dizüstü/Castle üzerinde çalışabilir; bulut bağımlılığı yoktur.
- **Açıklanabilir**: getirilen öğeler atıflı olmalıdır (dosya + konum) ve çıkarımdan ayrılabilmelidir.
- **Düşük tören**: günlük kayıtlar Markdown olarak kalır; ağır şema çalışması yoktur.
- **Artımlı**: v1 yalnızca FTS ile bile faydalıdır; semantik/vektör ve grafikler isteğe bağlı yükseltmelerdir.
- **Ajan dostu**: “token bütçeleri içinde geri çağırma”yı kolaylaştırır (küçük bilgi demetleri döndürür).

## Kuzey yıldızı modeli (Hindsight × Letta)

Harmanlanacak iki parça:

1. **Letta/MemGPT tarzı kontrol döngüsü**

- küçük bir “çekirdek” her zaman bağlamda tutulur (persona + temel kullanıcı gerçekleri)
- diğer her şey bağlam dışıdır ve araçlar üzerinden getirilir
- bellek yazımları açık araç çağrılarıdır (append/replace/insert), kalıcı hale getirilir ve bir sonraki turda yeniden enjekte edilir

2. **Hindsight tarzı bellek altlığı**

- separate what’s observed vs what’s believed vs what’s summarized
- retain/recall/reflect desteği
- kanıta dayalı olarak evrilebilen güven taşıyan görüşler
- varlık farkındalıklı geri çağırma + zamansal sorgular (tam bilgi grafikleri olmadan bile)

## Önerilen mimari (Markdown tek gerçek kaynak + türetilmiş indeks)

### Canonical store (git-friendly)

`~/.openclaw/workspace`’i kanonik, insan tarafından okunabilir bellek olarak tutun.

Önerilen çalışma alanı düzeni:

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

Notlar:

- **Günlük günlük olarak kalır**. JSON’a dönüştürmeye gerek yok.
- `bank/` dosyaları **kürasyonludur**, yansıtma işleri tarafından üretilir ve yine de elle düzenlenebilir.
- `memory.md` “küçük + çekirdek-benzeri” kalır: Clawd’ın her oturumda görmesini istediğiniz şeyler.

### Türetilmiş depo (makine geri çağırma)

Çalışma alanı altında (git ile izlenmesi şart olmayan) türetilmiş bir indeks ekleyin:

```
~/.openclaw/workspace/.memory/index.sqlite
```

Back it with:

- gerçekler + varlık bağlantıları + görüş metadatası için SQLite şeması
- sözcüksel geri çağırma için SQLite **FTS5** (hızlı, küçük, offline)
- semantik geri çağırma için isteğe bağlı gömme (hala offline)

İndeks her zaman **Markdown’dan yeniden oluşturulabilir**.

## Retain / Recall / Reflect (operasyonel döngü)

### Retain: günlük kayıtları “gerçekler”e normalize etme

Burada önemli olan Hindsight içgörüsü: küçük parçalar değil, **anlatı niteliğinde, kendi kendine yeterli gerçekler** saklayın.

`memory/YYYY-MM-DD.md` için pratik kural:

- gün sonunda (ya da gün içinde), 2–5 maddelik bir `## Retain` bölümü ekleyin:
  - anlatı niteliğinde (turlar arası bağlam korunur)
  - kendi kendine yeterli (sonradan tek başına anlamlı)
  - tür + varlık atıflarıyla etiketlenmiş

Örnek:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

Minimal ayrıştırma:

- Tür öneki: `W` (world), `B` (experience/biographical), `O` (opinion), `S` (observation/summary; genellikle üretilir)
- Varlıklar: `@Peter`, `@warelay` vb. (slug’lar `bank/entities/*.md`’e eşlenir)
- Görüş güveni: `O(c=0.0..1.0)` isteğe bağlı

Yazarların bunu düşünmesini istemiyorsanız: yansıtma işi bu maddeleri günlüğün geri kalanından çıkarabilir; ancak açık bir `## Retain` bölümü en kolay “kalite kaldıraç”tır.

### Recall: türetilmiş indeks üzerinde sorgular

Recall şunları desteklemelidir:

- **sözcüksel**: “birebir terimleri / isimleri / komutları bul” (FTS5)
- **varlık**: “X hakkında anlat” (varlık sayfaları + varlık bağlantılı gerçekler)
- **zamansal**: “27 Kasım civarında ne oldu” / “geçen haftadan beri”
- **görüş**: “Peter neyi tercih eder?” (güven + kanıt ile)

Dönüş biçimi ajan dostu olmalı ve kaynakları belirtmelidir:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (kaynak gün ya da varsa çıkarılmış zaman aralığı)
- `entities` (`["Peter","warelay"]`)
- `content` (anlatı niteliğindeki gerçek)
- `source` (`memory/2025-11-27.md#L12` vb.)

### Reflect: kararlı sayfalar üretme + inançları güncelleme

Yansıtma, zamanlanmış bir iştir (günlük ya da heartbeat `ultrathink`) ve şunları yapar:

- son gerçeklerden `bank/entities/*.md`’i günceller (varlık özetleri)
- pekiştirme/çelişkiye göre `bank/opinions.md` güvenini günceller
- isteğe bağlı olarak `memory.md` (“çekirdek-benzeri” kalıcı gerçekler) için düzenleme önerir

Görüş evrimi (basit, açıklanabilir):

- her görüş şunlara sahiptir:
  - ifade
  - güven `c ∈ [0,1]`
  - last_updated
  - kanıt bağlantıları (destekleyici + çelişen gerçek kimlikleri)
- yeni gerçekler geldiğinde:
  - varlık örtüşmesi + benzerliğe göre aday görüşleri bulun (önce FTS, sonra gömmeler)
  - güveni küçük deltalarla güncelleyin; büyük sıçramalar güçlü çelişki + tekrarlı kanıt gerektirir

## CLI entegrasyonu: bağımsız mı derin entegrasyon mu

Öneri: **OpenClaw ile derin entegrasyon**, ancak ayrılabilir bir çekirdek kütüphane ile.

### Neden OpenClaw içine entegre edelim?

- OpenClaw zaten şunları biliyor:
  - çalışma alanı yolu (`agents.defaults.workspace`)
  - oturum modeli + heartbeat’ler
  - günlükleme + sorun giderme kalıpları
- Aracın kendisinin araçları çağırmasını istiyorsunuz:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### Neden yine de bir kütüphane ayıralım?

- bellek mantığını gateway/runtime olmadan test edilebilir tutmak
- diğer bağlamlardan yeniden kullanmak (yerel betikler, gelecekte masaüstü uygulaması vb.)

Şekil:
Bellek araçlarının küçük bir CLI + kütüphane katmanı olması amaçlanır; ancak bu yalnızca keşif amaçlıdır.

## “S-Collide” / SuCo: ne zaman kullanılmalı (araştırma)

“S-Collide” **SuCo (Subspace Collision)**’a işaret ediyorsa: bu, alt uzaylarda öğrenilmiş/yapılandırılmış çarpışmalar kullanarak güçlü geri çağırma/gecikme dengeleri hedefleyen bir ANN geri getirme yaklaşımıdır (makale: arXiv 2411.14754, 2024).

`~/.openclaw/workspace` için pragmatik yaklaşım:

- SuCo ile **başlamayın**.
- SQLite FTS + (isteğe bağlı) basit gömmelerle başlayın; UX kazanımlarının çoğunu hemen elde edersiniz.
- SuCo/HNSW/ScaNN sınıfı çözümleri ancak şunlar olduğunda düşünün:
  - derlem büyük olduğunda (on/binlerce yüz binlerce parça)
  - brute-force embedding search becomes too slow
  - geri çağırma kalitesi sözcüksel arama tarafından anlamlı biçimde darboğaza girdiğinde

Offline dostu alternatifler (artan karmaşıklıkla):

- SQLite FTS5 + metadata filtreleri (sıfır ML)
- Embeddings + brute force (works surprisingly far if chunk count is low)
- HNSW indeksi (yaygın, sağlam; bir kütüphane bağlaması gerekir)
- SuCo (araştırma düzeyi; gömülebilecek sağlam bir uygulama varsa cazip)

Açık soru:

- makinelerinizde (dizüstü + masaüstü) “kişisel asistan belleği” için **en iyi** offline gömme modeli hangisi?
  - zaten Ollama’nız varsa: yerel bir modelle gömme yapın; aksi halde araç zincirine küçük bir gömme modeli ekleyin.

## En küçük faydalı pilot

If you want a minimal, still-useful version:

- `bank/` varlık sayfaları ve günlüklerde bir `## Retain` bölümü ekleyin.
- Atıflarla (yol + satır numaraları) geri çağırma için SQLite FTS kullanın.
- Geri çağırma kalitesi ya da ölçek gerektirirse gömmeleri ekleyin.

## Kaynaklar

- Letta / MemGPT kavramları: “core memory blocks” + “archival memory” + araç güdümlü kendi kendini düzenleyen bellek.
- Hindsight Teknik Raporu: “retain / recall / reflect”, dört ağlı bellek, anlatı gerçek çıkarımı, görüş güveninin evrimi.
- SuCo: arXiv 2411.14754 (2024): “Subspace Collision” yaklaşık en yakın komşu geri getirme.
