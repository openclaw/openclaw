---
summary: "OpenClaw içinde Venice AI gizlilik odaklı modellerini kullanın"
read_when:
  - OpenClaw içinde gizlilik odaklı çıkarım istiyorsunuz
  - Venice AI kurulum rehberine ihtiyacınız var
title: "Venice AI"
---

# Venice AI (Venice öne çıkan)

**Venice**, gizlilik öncelikli çıkarım için, isteğe bağlı olarak tescilli modellere anonimleştirilmiş erişim sunan öne çıkan Venice kurulumumuzdur.

Venice AI, sansürsüz modellere destek ve anonimleştirilmiş proxy üzerinden büyük tescilli modellere erişim ile gizlilik odaklı AI çıkarımı sağlar. Tüm çıkarımlar varsayılan olarak özeldir — verileriniz üzerinde eğitim yok, kayıt tutma yok.

## OpenClaw’da Neden Venice

- Açık kaynaklı modeller için **özel çıkarım** (kayıt yok).
- Gerektiğinde **sansürsüz modeller**.
- Kalite önemli olduğunda tescilli modellere **anonimleştirilmiş erişim** (Opus/GPT/Gemini).
- OpenAI uyumlu `/v1` uç noktaları.

## Gizlilik Modları

Venice iki gizlilik seviyesi sunar — doğru modeli seçmek için bunu anlamak kritik önemdedir:

| Mod                   | Açıklama                                                                                                                                                                | Modeller                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Özel**              | Tamamen özel. İstemler/yanıtlar **asla saklanmaz veya kaydedilmez**. Geçicidir.                                         | Llama, Qwen, DeepSeek, Venice Uncensored vb. |
| **Anonimleştirilmiş** | Meta veriler çıkarılarak Venice üzerinden proxy edilir. Alttaki sağlayıcı (OpenAI, Anthropic) anonim istekler görür. | Claude, GPT, Gemini, Grok, Kimi, MiniMax                     |

## Özellikler

- **Gizlilik odaklı**: “özel” (tamamen özel) ve “anonimleştirilmiş” (proxy’li) modlar arasında seçim
- **Sansürsüz modeller**: İçerik kısıtlaması olmayan modellere erişim
- **Büyük model erişimi**: Venice’in anonim proxy’si üzerinden Claude, GPT-5.2, Gemini, Grok kullanımı
- **OpenAI uyumlu API**: Kolay entegrasyon için standart `/v1` uç noktaları
- **Akış (Streaming)**: ✅ Tüm modellerde desteklenir
- **Fonksiyon çağırma**: ✅ Seçili modellerde desteklenir (model yeteneklerini kontrol edin)
- **Görsel (Vision)**: ✅ Görsel yeteneği olan modellerde desteklenir
- **Katı hız limitleri yok**: Aşırı kullanımda adil kullanım kısıtlaması uygulanabilir

## Kurulum

### 1. API Anahtarı Alın

1. [venice.ai](https://venice.ai) adresinden kaydolun
2. **Settings → API Keys → Create new key** yolunu izleyin
3. API anahtarınızı kopyalayın (format: `vapi_xxxxxxxxxxxx`)

### 2) OpenClaw’ı Yapılandırın

**Seçenek A: Ortam Değişkeni**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Seçenek B: Etkileşimli Kurulum (Önerilen)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Bu işlem şunları yapar:

1. API anahtarınızı ister (veya mevcut `VENICE_API_KEY`’yi kullanır)
2. Tüm mevcut Venice modellerini gösterir
3. Varsayılan modelinizi seçmenizi sağlar
4. Sağlayıcıyı otomatik olarak yapılandırır

**Seçenek C: Etkileşimsiz**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Kurulumu Doğrulayın

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Model Seçimi

Kurulumdan sonra OpenClaw tüm mevcut Venice modellerini gösterir. İhtiyaçlarınıza göre seçin:

- **Varsayılan (önerimiz)**: Özel, dengeli performans için `venice/llama-3.3-70b`.
- **En iyi genel kalite**: Zor işler için `venice/claude-opus-45` (Opus hâlâ en güçlü).
- **Gizlilik**: Tamamen özel çıkarım için “özel” modelleri seçin.
- **Yetenek**: Venice proxy’si üzerinden Claude, GPT, Gemini’ye erişmek için “anonimleştirilmiş” modelleri seçin.

Varsayılan modelinizi istediğiniz zaman değiştirin:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Tüm mevcut modelleri listeleyin:

```bash
openclaw models list | grep venice
```

## `openclaw configure` ile Yapılandırma

1. `openclaw configure` komutunu çalıştırın
2. **Model/auth** seçin
3. **Venice AI**’ı seçin

## Hangi Modeli Kullanmalıyım?

| Kullanım Senaryosu             | Önerilen Model                   | Neden                                |
| ------------------------------ | -------------------------------- | ------------------------------------ |
| **Genel sohbet**               | `llama-3.3-70b`                  | İyi genel performans, tamamen özel   |
| **En iyi genel kalite**        | `claude-opus-45`                 | Zor görevler için Opus en güçlüdür   |
| **Gizlilik + Claude kalitesi** | `claude-opus-45`                 | Anonim proxy ile en iyi akıl yürütme |
| **Kodlama**                    | `qwen3-coder-480b-a35b-instruct` | Koda optimize, 262k bağlam           |
| **Görsel görevler**            | `qwen3-vl-235b-a22b`             | En iyi özel görsel model             |
| **Sansürsüz**                  | `venice-uncensored`              | İçerik kısıtlaması yok               |
| **Hızlı + ucuz**               | `qwen3-4b`                       | Hafif, yine de yetenekli             |
| **Karmaşık akıl yürütme**      | `deepseek-v3.2`                  | Güçlü akıl yürütme, özel             |

## Mevcut Modeller (Toplam 25)

### Özel Modeller (15) — Tamamen Özel, Kayıt Yok

| Model Kimliği                    | Adı                                        | Context (tokens) | Özellikler              |
| -------------------------------- | ------------------------------------------ | ----------------------------------- | ----------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                                | Genel                   |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                                | Hızlı, hafif            |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                                | Complex tasks           |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                                | Reasoning               |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                                | Genel                   |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                                | Kod                     |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                                | Genel                   |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                                | Görsel                  |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                 | Hızlı, akıl yürütme     |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                                | Reasoning               |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                 | Uncensored              |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                                | Görsel                  |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                                | Görsel                  |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                                | Genel                   |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                                | Reasoning, multilingual |

### Anonimleştirilmiş Modeller (10) — Venice Proxy Üzerinden

| Model Kimliği            | Orijinal                          | Context (tokens) | Özellikler           |
| ------------------------ | --------------------------------- | ----------------------------------- | -------------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                                | Akıl yürütme, görsel |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                                | Akıl yürütme, görsel |
| `openai-gpt-52`          | GPT-5.2           | 262k                                | Reasoning            |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                                | Akıl yürütme, görsel |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                                | Akıl yürütme, görsel |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                                | Akıl yürütme, görsel |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                                | Akıl yürütme, görsel |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                                | Akıl yürütme, kod    |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                                | Reasoning            |
| `minimax-m21`            | MiniMax M2.1      | 202k                                | Reasoning            |

## Model Keşfi

`VENICE_API_KEY` ayarlandığında OpenClaw, Venice API’den modelleri otomatik olarak keşfeder. API’ye ulaşılamazsa statik bir kataloğa geri döner.

`/models` uç noktası herkese açıktır (listeleme için kimlik doğrulama gerekmez), ancak çıkarım için geçerli bir API anahtarı gerekir.

## Akış ve Araç Desteği

| Özellik                                 | Destek                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| **Akış (Streaming)** | ✅ Tüm modeller                                                                  |
| **Fonksiyon çağırma**                   | ✅ Çoğu model (API’de `supportsFunctionCalling` kontrol edin) |
| **Görsel/Resimler**                     | ✅ “Vision” özelliği işaretli modeller                                           |
| **JSON modu**                           | ✅ `response_format` ile desteklenir                                             |

## Fiyatlandırma

Venice kredi tabanlı bir sistem kullanır. Güncel oranlar için [venice.ai/pricing](https://venice.ai/pricing) sayfasını kontrol edin:

- **Özel modeller**: Genellikle daha düşük maliyet
- **Anonimleştirilmiş modeller**: Doğrudan API fiyatlandırmasına benzer + küçük bir Venice ücreti

## Karşılaştırma: Venice vs Doğrudan API

| Aspect         | Venice (Anonimleştirilmiş) | Doğrudan API           |
| -------------- | --------------------------------------------- | ---------------------- |
| **Gizlilik**   | Meta veriler çıkarılır, anonim                | Hesabınız bağlı        |
| **Gecikme**    | +10–50ms (proxy)           | Doğrudan               |
| **Özellikler** | Çoğu özellik desteklenir                      | Tüm özellikler         |
| **Faturalama** | Venice kredileri                              | Sağlayıcı faturalaması |

## Kullanım Örnekleri

```bash
# Use default private model
openclaw chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
openclaw chat --model venice/claude-opus-45

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## Sorun Giderme

### API anahtarı tanınmıyor

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Anahtarın `vapi_` ile başladığından emin olun.

### Model mevcut değil

Venice model kataloğu dinamik olarak güncellenir. Şu anda mevcut modelleri görmek için `openclaw models list` komutunu çalıştırın. Bazı modeller geçici olarak çevrimdışı olabilir.

### Bağlantı sorunları

Venice API adresi `https://api.venice.ai/api/v1`’dir. Ağınızın HTTPS bağlantılarına izin verdiğinden emin olun.

## Yapılandırma dosyası örneği

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Bağlantılar

- [Venice AI](https://venice.ai)
- [API Dokümantasyonu](https://docs.venice.ai)
- [Fiyatlandırma](https://venice.ai/pricing)
- [Durum](https://status.venice.ai)
