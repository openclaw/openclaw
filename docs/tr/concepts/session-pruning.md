---
summary: "Session pruning: tool-result trimming to reduce context bloat"
read_when:
  - Araç çıktılarından kaynaklanan LLM bağlam büyümesini azaltmak istiyorsunuz
  - agents.defaults.contextPruning ayarını inceliyorsunuz
---

# Session Pruning

Oturum budama, her LLM çağrısından hemen önce bellek içi bağlamdan **eski araç sonuçlarını** kırpar. Diskteki oturum geçmişini **yeniden yazmaz** (`*.jsonl`).

## Ne zaman çalışır

- `mode: "cache-ttl"` etkinleştirildiğinde ve oturum için son Anthropic çağrısı `ttl`’ten daha eskiyse.
- Yalnızca o istek için modele gönderilen iletileri etkiler.
- Yalnızca Anthropic API çağrıları (ve OpenRouter Anthropic modelleri) için etkindir.
- En iyi sonuçlar için `ttl` değerini modelinizin `cacheControlTtl` değeriyle eşleştirin.
- Bir budamadan sonra TTL penceresi sıfırlanır; böylece sonraki istekler `ttl` yeniden dolana kadar önbelleği korur.

## Akıllı varsayılanlar (Anthropic)

- **OAuth veya setup-token** profilleri: `cache-ttl` budamayı etkinleştirir ve heartbeat’i `1h` olarak ayarlar.
- **API anahtarı** profilleri: `cache-ttl` budamayı etkinleştirir, heartbeat’i `30m` olarak ayarlar ve Anthropic modellerinde `cacheControlTtl` için varsayılanı `1h` yapar.
- Bu değerlerden herhangi birini açıkça ayarlarsanız, OpenClaw **bunları geçersiz kılmaz**.

## Bunun iyileştirdikleri (maliyet + önbellek davranışı)

- **Neden budama:** Anthropic istem önbellekleme yalnızca TTL içinde geçerlidir. Bir oturum TTL’i aşacak kadar boşta kalırsa, bir sonraki istek kırpmadan önce tüm istemi yeniden önbelleğe alır.
- **Ne ucuzlar:** budama, TTL süresi dolduktan sonraki ilk istekte **cacheWrite** boyutunu azaltır.
- **TTL sıfırlamasının önemi:** budama çalıştığında önbellek penceresi sıfırlanır; böylece takip eden istekler, tüm geçmişi yeniden önbelleğe almak yerine yeni önbelleğe alınmış istemi yeniden kullanabilir.
- **Ne yapmaz:** budama belirteç eklemez veya maliyetleri “ikiye katlamaz”; yalnızca TTL sonrası ilk istekte neyin önbelleğe alındığını değiştirir.

## Neler budanabilir

- Yalnızca `toolResult` iletileri.
- Kullanıcı + asistan iletileri **asla** değiştirilmez.
- Son `keepLastAssistants` asistan iletisi korunur; bu kesitten sonraki araç sonuçları budanmaz.
- If there aren’t enough assistant messages to establish the cutoff, pruning is skipped.
- **Görüntü blokları** içeren araç sonuçları atlanır (asla kırpılmaz/temizlenmez).

## Bağlam penceresi tahmini

Budama, tahmini bir bağlam penceresi kullanır (karakter ≈ belirteç × 4). Temel pencere şu sırayla çözülür:

1. `models.providers.*.models[].contextWindow` geçersiz kılma.
2. Model tanımı `contextWindow` (model kayıt defterinden).
3. Varsayılan `200000` belirteç.

`agents.defaults.contextTokens` ayarlanmışsa, çözümlenen pencere için bir üst sınır (min) olarak ele alınır.

## Mod

### cache-ttl

- Budama yalnızca son Anthropic çağrısı `ttl`’ten daha eskiyse çalışır (varsayılan `5m`).
- Çalıştığında: öncekiyle aynı soft-kırpma + hard-temizleme davranışı.

## Soft ve hard budama

- **Soft-kırpma**: yalnızca aşırı büyük araç sonuçları için.
  - Baş + sonu korur, araya `...` ekler ve özgün boyutu belirten bir not ekler.
  - Görüntü blokları olan sonuçları atlar.
- **Hard-temizleme**: tüm araç sonucunu `hardClear.placeholder` ile değiştirir.

## Araç seçimi

- `tools.allow` / `tools.deny`, `*` joker karakterlerini destekler.
- Deny wins.
- Matching is case-insensitive.
- Boş izin listesi => tüm araçlara izin verilir.

## Diğer sınırlarla etkileşim

- Yerleşik araçlar kendi çıktılarının bir kısmını zaten kırpar; oturum budama, uzun süreli sohbetlerin model bağlamında çok fazla araç çıktısı biriktirmesini önleyen ek bir katmandır.
- Sıkıştırma (compaction) ayrıdır: sıkıştırma özetler ve kalıcı hale getirir; budama ise istek başına geçicidir. [/concepts/compaction](/concepts/compaction).

## Varsayılanlar (etkinleştirildiğinde)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Örnekler

Varsayılan (kapalı):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

TTL farkındalıklı budamayı etkinleştir:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Budamayı belirli araçlarla sınırla:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

Yapılandırma başvurusuna bakın: [Gateway Yapılandırması](/gateway/configuration)
