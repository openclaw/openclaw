---
summary: "Models CLI: listele, ayarla, takma adlar, yedekler, tara, durum"
read_when:
  - Models CLI’yi eklerken veya değiştirirken (models list/set/scan/aliases/fallbacks)
  - Model yedekleme davranışını veya seçim UX’ini değiştirirken
  - Model tarama yoklamalarını güncellerken (araçlar/görseller)
title: "Models CLI"
---

# Models CLI

Kimlik doğrulama profili rotasyonu, soğuma süreleri ve bunların yedeklerle nasıl etkileştiği için
[/concepts/model-failover](/concepts/model-failover) bölümüne bakın.
Hızlı sağlayıcı genel bakışı + örnekler: [/concepts/model-providers](/concepts/model-providers).

## Model seçimi nasıl çalışır

OpenClaw modelleri şu sırayla seçer:

1. **Birincil** model (`agents.defaults.model.primary` veya `agents.defaults.model`).
2. `agents.defaults.model.fallbacks` içindeki **Yedekler** (sırayla).
3. **Sağlayıcı kimlik doğrulama failover**’ı, bir sonraki modele geçmeden önce sağlayıcı içinde gerçekleşir.

İlgili:

- `agents.defaults.models`, OpenClaw’ın kullanabileceği modellerin (ve takma adların) izin listesi/kataloğudur.
- `agents.defaults.imageModel`, **yalnızca** birincil model görselleri kabul edemediğinde kullanılır.
- Ajan başına varsayılanlar, `agents.list[].model` artı bağlamalar aracılığıyla `agents.defaults.model`’i geçersiz kılabilir (bkz. [/concepts/multi-agent](/concepts/multi-agent)).

## Hızlı model seçimleri (anekdot)

- **GLM**: kodlama/araç çağırma için biraz daha iyi.
- **MiniMax**: yazma ve genel hissiyat için daha iyi.

## Kurulum sihirbazı (önerilir)

Yapılandırmayı elle düzenlemek istemiyorsanız, başlangıç sihirbazını çalıştırın:

```bash
openclaw onboard
```

Model + kimlik doğrulamayı yaygın sağlayıcılar için ayarlayabilir; **OpenAI Code (Codex)
aboneliği** (OAuth) ve **Anthropic** (API anahtarı önerilir; `claude
setup-token` da desteklenir) dahildir.

## Yapılandırma anahtarları (genel bakış)

- `agents.defaults.model.primary` ve `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` ve `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (izin listesi + takma adlar + sağlayıcı parametreleri)
- `models.providers` ( `models.json` içine yazılan özel sağlayıcılar)

Model başvuruları küçük harfe normalize edilir. `z.ai/*` gibi sağlayıcı takma adları
`zai/*`’e normalize edilir.

Sağlayıcı yapılandırma örnekleri (OpenCode Zen dahil) şurada bulunur:
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## “Model izinli değil” (ve yanıtların neden durduğu)

`agents.defaults.models` ayarlanırsa, `/model` ve oturum geçersiz kılmaları için **izin listesi**
haline gelir. Bir kullanıcı bu izin listesinde olmayan bir modeli seçtiğinde,
OpenClaw şunu döndürür:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Bu, normal bir yanıt üretilmeden **önce** gerçekleşir; bu nedenle mesaj “yanıt vermedi”
gibi hissedilebilir. Düzeltmek için:

- Modeli `agents.defaults.models`’e ekleyin, veya
- İzin listesini temizleyin (`agents.defaults.models`’i kaldırın), veya
- `/model list`’ten bir model seçin.

Örnek izin listesi yapılandırması:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Sohbette model değiştirme (`/model`)

Yeniden başlatmadan, mevcut oturum için modelleri değiştirebilirsiniz:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Notlar:

- `/model` (ve `/model list`), kompakt ve numaralı bir seçicidir (model ailesi + mevcut sağlayıcılar).
- `/model <#>`, bu seçiciden seçim yapar.
- `/model status`, ayrıntılı görünümdür (kimlik doğrulama adayları ve yapılandırıldığında sağlayıcı uç noktası `baseUrl` + `api` modu).
- Model başvuruları **ilk** `/`’e göre bölünerek ayrıştırılır. `/model <ref>` yazarken `provider/model` kullanın.
- Model kimliğinin kendisi `/` içeriyorsa (OpenRouter tarzı), sağlayıcı önekini eklemelisiniz (örnek: `/model openrouter/moonshotai/kimi-k2`).
- Sağlayıcıyı atlatırsanız, OpenClaw girdiyi bir takma ad ya da **varsayılan sağlayıcı** için bir model olarak değerlendirir (yalnızca model kimliğinde `/` yoksa çalışır).

Komutların tam davranışı/yapılandırması: [Slash commands](/tools/slash-commands).

## CLI komutları

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (alt komut olmadan), `models status` için bir kısayoldur.

### `models list`

Varsayılan olarak yapılandırılmış modelleri gösterir. Kullanışlı bayraklar:

- `--all`: tam katalog
- `--local`: yalnızca yerel sağlayıcılar
- `--provider <name>`: sağlayıcıya göre filtrele
- `--plain`: satır başına bir model
- `--json`: makine tarafından okunabilir çıktı

### `models status`

Çözümlenmiş birincil modeli, yedekleri, görsel modelini ve yapılandırılmış
sağlayıcıların kimlik doğrulama genel görünümünü gösterir. Ayrıca kimlik doğrulama deposunda
bulunan profiller için OAuth sona erme durumunu yüzeye çıkarır (varsayılan olarak 24 saat içinde uyarır). `--plain` yalnızca çözümlenmiş birincil modeli yazdırır.
OAuth durumu her zaman gösterilir (ve `--json` çıktısına dahildir). Yapılandırılmış bir
sağlayıcının kimlik bilgileri yoksa, `models status` **Missing auth** bölümünü yazdırır.
JSON, `auth.oauth` (uyarı penceresi + profiller) ve `auth.providers`
(sağlayıcı başına etkin kimlik doğrulama) içerir.
Otomasyon için `--check` kullanın (eksik/süresi dolmuşsa çıkış `1`, süresi dolmak üzereyse `2`).

Tercih edilen Anthropic kimlik doğrulaması Claude Code CLI setup-token’ıdır (her yerde çalıştırın; gerekirse gateway ana makinesine yapıştırın):

```bash
claude setup-token
openclaw models status
```

## Tarama (OpenRouter ücretsiz modeller)

`openclaw models scan`, OpenRouter’ın **ücretsiz model kataloğunu** inceler ve
isteğe bağlı olarak modelleri araç ve görsel desteği için yoklayabilir.

Temel bayraklar:

- `--no-probe`: canlı yoklamaları atla (yalnızca meta veriler)
- `--min-params <b>`: minimum parametre boyutu (milyar)
- `--max-age-days <days>`: daha eski modelleri atla
- `--provider <name>`: sağlayıcı önek filtresi
- `--max-candidates <n>`: yedek liste boyutu
- `--set-default`: `agents.defaults.model.primary`’ü ilk seçime ayarla
- `--set-image`: `agents.defaults.imageModel.primary`’yı ilk görsel seçime ayarla

Yoklama için bir OpenRouter API anahtarı gerekir (kimlik doğrulama profillerinden veya
`OPENROUTER_API_KEY`). Anahtar olmadan, yalnızca adayları listelemek için `--no-probe` kullanın.

Tarama sonuçları şu ölçütlere göre sıralanır:

1. Görsel desteği
2. Tool latency
3. Bağlam boyutu
4. Parametre sayısı

Input

- OpenRouter `/models` listesi ( `:free` filtresi)
- Kimlik doğrulama profillerinden veya `OPENROUTER_API_KEY`’den OpenRouter API anahtarı gerektirir (bkz. [/environment](/help/environment))
- İsteğe bağlı filtreler: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Yoklama denetimleri: `--timeout`, `--concurrency`

TTY’de çalıştırıldığında, yedekleri etkileşimli olarak seçebilirsiniz. Etkileşimsiz
modda, varsayılanları kabul etmek için `--yes` geçin.

## Model kayıt defteri (`models.json`)

`models.providers` içindeki özel sağlayıcılar, ajan dizini altında
(varsayılan `~/.openclaw/agents/<agentId>/models.json`) `models.json` içine yazılır. Bu dosya,
`models.mode` `replace` olarak ayarlanmadıkça varsayılan olarak birleştirilir.
