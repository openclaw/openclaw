---
summary: "OpenClaw'ı yerel LLM'ler üzerinde çalıştırın (LM Studio, vLLM, LiteLLM, özel OpenAI uç noktaları)"
read_when:
  - Kendi GPU sunucunuzdan modeller sunmak istiyorsunuz
  - LM Studio veya OpenAI uyumlu bir proxy bağlıyorsunuz
  - En güvenli yerel model rehberliğine ihtiyacınız var
title: "Yerel Modeller"
---

# Yerel modeller

Yerel kullanım mümkündür; ancak OpenClaw, **geniş bağlam** ve **prompt injection’a karşı güçlü savunmalar** bekler. Küçük kartlar bağlamı keser ve güvenliği sızdırır. Hedefi yüksek tutun: **≥2 tam donanımlı Mac Studio veya eşdeğeri bir GPU sistemi (~30 bin $+)**. Tek bir **24 GB** GPU, yalnızca daha hafif istemler için ve daha yüksek gecikmeyle çalışır. **Çalıştırabildiğiniz en büyük / tam boy model varyantını kullanın**; agresif şekilde kuantize edilmiş veya “küçük” kontrol noktaları prompt injection riskini artırır (bkz. [Güvenlik](/gateway/security)).

## Önerilen: LM Studio + MiniMax M2.1 (Responses API, tam boy)

Güncel en iyi yerel yığın. MiniMax M2.1’i LM Studio’da yükleyin, yerel sunucuyu etkinleştirin (varsayılan `http://127.0.0.1:1234`) ve muhakemeyi nihai metinden ayrı tutmak için Responses API’yi kullanın.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
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

**Kurulum kontrol listesi**

- LM Studio’yu yükleyin: [https://lmstudio.ai](https://lmstudio.ai)
- LM Studio’da **mevcut en büyük MiniMax M2.1 sürümünü** indirin (“small”/ağır kuantize edilmiş varyantlardan kaçının), sunucuyu başlatın ve `http://127.0.0.1:1234/v1/models` içinde listelendiğini doğrulayın.
- Modeli yüklü tutun; soğuk yükleme başlangıç gecikmesi ekler.
- LM Studio sürümünüz farklıysa `contextWindow`/`maxTokens` ayarlarını düzenleyin.
- WhatsApp için, yalnızca nihai metnin gönderilmesi adına Responses API’ye bağlı kalın.

Yerel çalıştırırken bile barındırılan modelleri yapılandırılmış halde tutun; yedeklerin kullanılabilir kalması için `models.mode: "merge"` kullanın.

### Hibrit yapılandırma: barındırılan birincil, yerel yedek

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
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

### Yerel-öncelikli, barındırılan güvenlik ağı

Birincil ve yedek sırasını değiştirin; aynı sağlayıcılar bloğunu ve `models.mode: "merge"`’i koruyun; böylece yerel makine kapalıyken Sonnet veya Opus’a geri dönebilirsiniz.

### Bölgesel barındırma / veri yönlendirme

- Barındırılan MiniMax/Kimi/GLM varyantları OpenRouter üzerinde bölgeye sabitlenmiş uç noktalarla (ör. ABD barındırmalı) da mevcuttur. Trafiği seçtiğiniz yargı alanında tutmak için orada bölgesel varyantı seçin; yine de Anthropic/OpenAI yedekleri için `models.mode: "merge"` kullanın.
- Yalnızca yerel kullanım en güçlü gizlilik yoludur; barındırılan bölgesel yönlendirme, sağlayıcı özelliklerine ihtiyaç duyup veri akışı üzerinde kontrol istediğinizde orta yoldur.

## Diğer OpenAI uyumlu yerel proxy’ler

vLLM, LiteLLM, OAI-proxy veya özel gateway’ler, OpenAI tarzı bir `/v1` uç noktası sundukları sürece çalışır. Yukarıdaki sağlayıcı bloğunu kendi uç noktanız ve model kimliğinizle değiştirin:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Barındırılan modellerin yedek olarak kullanılabilir kalması için `models.mode: "merge"`’i koruyun.

## Sorun Giderme

- Gateway proxy’ye erişebiliyor mu? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio modeli boşaltıldı mı? Yeniden yükleyin; soğuk başlangıç “takılı kalma”nın yaygın bir nedenidir.
- Bağlam hataları mı? `contextWindow`’ü düşürün veya sunucu limitinizi yükseltin.
- Güvenli kullanım: yerel modeller sağlayıcı tarafı filtreleri atlar; prompt injection etki alanını sınırlamak için ajanları dar tutun ve sıkıştırmayı açık bırakın.
