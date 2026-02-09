---
summary: "OpenClaw’da MiniMax M2.1’i kullanın"
read_when:
  - OpenClaw’da MiniMax modellerini istiyorsanız
  - MiniMax kurulum rehberine ihtiyacınız varsa
title: "MiniMax"
---

# MiniMax

MiniMax, **M2/M2.1** model ailesini geliştiren bir yapay zekâ şirketidir. Mevcut
kodlama odaklı sürüm, gerçek dünyadaki karmaşık görevler için tasarlanmış
**MiniMax M2.1**’dir (23 Aralık 2025).

Kaynak: [MiniMax M2.1 sürüm notu](https://www.minimax.io/news/minimax-m21)

## Model genel bakış (M2.1)

MiniMax, M2.1’de şu iyileştirmeleri vurgular:

- Daha güçlü **çok dilli kodlama** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Daha iyi **web/uygulama geliştirme** ve estetik çıktı kalitesi (yerel mobil dâhil).
- Ofis tarzı iş akışları için **bileşik talimat** işleme; iç içe düşünme ve entegre
  kısıt yürütme üzerine inşa edilmiştir.
- Daha düşük token kullanımı ve daha hızlı yineleme döngüleriyle **daha öz yanıtlar**.
- **Araç/ajan çerçevesi** uyumluluğu ve bağlam yönetiminde daha güçlü performans (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Daha yüksek kaliteli **diyalog ve teknik yazım** çıktıları.

## MiniMax M2.1 ile MiniMax M2.1 Lightning karşılaştırması

- **Hız:** Lightning, MiniMax’in fiyatlandırma belgelerinde “hızlı” varyanttır.
- **Maliyet:** Fiyatlandırma aynı girdi maliyetini gösterir; ancak Lightning’in çıktı maliyeti daha yüksektir.
- **Kodlama planı yönlendirmesi:** Lightning arka ucu MiniMax kodlama planında doğrudan
  kullanılabilir değildir. MiniMax çoğu isteği otomatik olarak Lightning’e yönlendirir,
  ancak trafik artışlarında normal M2.1 arka ucuna geri döner.

## Bir kurulum seçin

### MiniMax OAuth (Kodlama Planı) — önerilir

**En iyisi:** OAuth üzerinden MiniMax Kodlama Planı ile hızlı kurulum; API anahtarı gerekmez.

Birlikte gelen OAuth eklentisini etkinleştirin ve kimlik doğrulayın:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Bir uç nokta seçmeniz istenecektir:

- **Global** - Uluslararası kullanıcılar (`api.minimax.io`)
- **CN** - Çin’deki kullanıcılar (`api.minimaxi.com`)

Ayrıntılar için [MiniMax OAuth eklentisi README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) sayfasına bakın.

### MiniMax M2.1 (API anahtarı)

**En iyisi:** Anthropic uyumlu API ile barındırılan MiniMax.

CLI üzerinden yapılandırın:

- `openclaw configure` çalıştırın
- **Model/auth** seçin
- **MiniMax M2.1**’i seçin

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 yedek olarak (Opus birincil)

**En iyisi:** Opus 4.6’yı birincil tutup MiniMax M2.1’e devretmek.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### İsteğe bağlı: LM Studio üzerinden yerel (manuel)

**En iyisi:** LM Studio ile yerel çıkarım.
Güçlü donanımda (örn. masaüstü/sunucu) LM Studio’nun yerel sunucusunu kullanarak
MiniMax M2.1 ile güçlü sonuçlar gördük.

`openclaw.json` üzerinden manuel yapılandırın:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## `openclaw configure` üzerinden yapılandırma

JSON düzenlemeden MiniMax’i ayarlamak için etkileşimli yapılandırma sihirbazını kullanın:

1. `openclaw configure` çalıştırın.
2. **Model/auth** seçin.
3. **MiniMax M2.1**’i seçin.
4. İstendiğinde varsayılan modelinizi seçin.

## Yapılandırma seçenekleri

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic`’yi tercih edin (Anthropic uyumlu); `https://api.minimax.io/v1` OpenAI uyumlu yükler için isteğe bağlıdır.
- `models.providers.minimax.api`: `anthropic-messages`’i tercih edin; `openai-completions` OpenAI uyumlu yükler için isteğe bağlıdır.
- `models.providers.minimax.apiKey`: MiniMax API anahtarı (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost` tanımlayın.
- `agents.defaults.models`: izin listesinde istediğiniz modelleri takma adlayın.
- `models.mode`: MiniMax’i yerleşiklerin yanına eklemek istiyorsanız `merge`’i koruyun.

## Notlar

- Model referansları `minimax/<model>`’dur.
- Kodlama Planı kullanım API’si: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (kodlama planı anahtarı gerektirir).
- Tam maliyet takibi gerekiyorsa `models.json` içindeki fiyatlandırma değerlerini güncelleyin.
- MiniMax Kodlama Planı için referans bağlantısı (%10 indirim): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Sağlayıcı kuralları için [/concepts/model-providers](/concepts/model-providers) sayfasına bakın.
- Geçiş yapmak için `openclaw models list` ve `openclaw models set minimax/MiniMax-M2.1` kullanın.

## Sorun Giderme

### “Unknown model: minimax/MiniMax-M2.1”

Bu genellikle **MiniMax sağlayıcısının yapılandırılmadığı** anlamına gelir (sağlayıcı girdisi yoktur
ve MiniMax kimlik doğrulama profili/ortam anahtarı bulunamaz). Bu algılama için bir düzeltme
**2026.1.12** sürümündedir (yazım sırasında yayımlanmamıştır). Çözüm:

- **2026.1.12**’ye yükseltin (veya kaynaktan çalıştırın `main`), ardından gateway’i yeniden başlatın.
- `openclaw configure` çalıştırıp **MiniMax M2.1**’i seçin, ya da
- `models.providers.minimax` bloğunu manuel olarak ekleyin, ya da
- Sağlayıcının enjekte edilebilmesi için `MINIMAX_API_KEY` (veya bir MiniMax kimlik doğrulama profili) ayarlayın.

Model kimliğinin **büyük/küçük harfe duyarlı** olduğundan emin olun:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Ardından şununla yeniden kontrol edin:

```bash
openclaw models list
```
