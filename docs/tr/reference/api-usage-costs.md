---
summary: "Hangi unsurların para harcayabileceğini, hangi anahtarların kullanıldığını ve kullanımın nasıl görüntüleneceğini denetleyin"
read_when:
  - Hangi özelliklerin ücretli API’leri çağırabileceğini anlamak istiyorsunuz
  - Anahtarları, maliyetleri ve kullanım görünürlüğünü denetlemeniz gerekiyor
  - /status veya /usage maliyet raporlamasını açıklıyorsunuz
title: "API Kullanımı ve Maliyetler"
---

# API kullanımı ve maliyetler

Bu doküman, **API anahtarlarını çağırabilen özellikleri** ve bunların maliyetlerinin nerede göründüğünü listeler. Sağlayıcı kullanımı veya ücretli API çağrıları oluşturabilen OpenClaw özelliklerine odaklanır.

## Maliyetler nerede görünür (sohbet + CLI)

**Oturum başına maliyet anlık görüntüsü**

- `/status`, geçerli oturum modelini, bağlam kullanımını ve son yanıt belirteçlerini gösterir.
- Model **API anahtarıyla kimlik doğrulama** kullanıyorsa, `/status` son yanıt için **tahmini maliyeti** de gösterir.

**Mesaj başına maliyet altbilgisi**

- `/usage full`, her yanıta **tahmini maliyet** dahil bir kullanım altbilgisi ekler (yalnızca API anahtarı).
- `/usage tokens` yalnızca belirteçleri gösterir; OAuth akışları dolar maliyetini gizler.

**CLI kullanım pencereleri (sağlayıcı kotaları)**

- `openclaw status --usage` ve `openclaw channels list`, sağlayıcı **kullanım pencerelerini** gösterir
  (mesaj başına maliyetler değil, kota anlık görüntüleri).

Ayrıntılar ve örnekler için [Token kullanımı ve maliyetler](/reference/token-use) bölümüne bakın.

## Anahtarlar nasıl keşfedilir

OpenClaw, kimlik bilgilerini şuralardan alabilir:

- **Kimlik doğrulama profilleri** (ajan başına, `auth-profiles.json` içinde saklanır).
- **Ortam değişkenleri** (örn. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Yapılandırma** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`) — anahtarları skill işlem ortamına aktarabilir.

## Anahtar harcayabilen özellikler

### 1. Çekirdek model yanıtları (sohbet + araçlar)

Her yanıt veya araç çağrısı **geçerli model sağlayıcısını** (OpenAI, Anthropic vb.) kullanır. Bu,
kullanım ve maliyetin birincil kaynağıdır.

Fiyatlandırma yapılandırması için [Modeller](/providers/models) ve görüntüleme için [Token kullanımı ve maliyetler](/reference/token-use) bölümüne bakın.

### 2. Medya anlama (ses/görüntü/video)

Gelen medya, yanıt çalışmadan önce özetlenebilir veya yazıya dökülebilir. Bu, model/sağlayıcı API’lerini kullanır.

- Ses: OpenAI / Groq / Deepgram (anahtarlar mevcutsa artık **otomatik etkin**).
- Görüntü: OpenAI / Anthropic / Google.
- Video: Google.

Bkz. [Medya anlama](/nodes/media-understanding).

### 3. Bellek gömmeleri + anlamsal arama

Anlamsal bellek araması, uzak sağlayıcılar için yapılandırıldığında **gömme API’lerini** kullanır:

- `memorySearch.provider = "openai"` → OpenAI gömmeleri
- `memorySearch.provider = "gemini"` → Gemini gömmeleri
- `memorySearch.provider = "voyage"` → Voyage gömmeleri
- Yerel gömmeler başarısız olursa isteğe bağlı olarak uzak sağlayıcıya geri dönüş

`memorySearch.provider = "local"` ile yerel tutabilirsiniz (API kullanımı yok).

[Bellek](/concepts/memory).

### 4. Web arama aracı (Brave / Perplexity via OpenRouter)

`web_search`, API anahtarlarını kullanır ve kullanım ücretlerine yol açabilir:

- **Brave Search API**: `BRAVE_API_KEY` veya `tools.web.search.apiKey`
- **Perplexity** (OpenRouter üzerinden): `PERPLEXITY_API_KEY` veya `OPENROUTER_API_KEY`

**Brave ücretsiz katman (cömert):**

- **Aylık 2.000 istek**
- **Saniyede 1 istek**
- Doğrulama için **kredi kartı gerekli** (yükseltmedikçe ücret yok)

[Web araçları](/tools/web).

### 5. Web getirme aracı (Firecrawl)

`web_fetch`, bir API anahtarı mevcut olduğunda **Firecrawl** çağırabilir:

- `FIRECRAWL_API_KEY` veya `tools.web.fetch.firecrawl.apiKey`

Firecrawl yapılandırılmamışsa, araç doğrudan getirme + okunabilirlik yöntemine geri döner (ücretli API yok).

[Web araçları](/tools/web).

### 6. Sağlayıcı kullanım anlık görüntüleri (durum/sağlık)

Bazı durum komutları, kota pencerelerini veya kimlik doğrulama sağlığını göstermek için **sağlayıcı kullanım uç noktalarını** çağırır.
Bunlar genellikle düşük hacimli çağrılardır ancak yine de sağlayıcı API’lerine isabet eder:

- `openclaw status --usage`
- `openclaw models status --json`

[Models CLI](/cli/models).

### 7. Sıkıştırma koruması özetleme

Sıkıştırma koruması, **geçerli modeli** kullanarak oturum geçmişini özetleyebilir; çalıştığında sağlayıcı API’lerini çağırır.

[Oturum yönetimi + sıkıştırma](/reference/session-management-compaction).

### 8. Model tarama / yoklama

`openclaw models scan`, OpenRouter modellerini yoklayabilir ve yoklama etkinleştirildiğinde `OPENROUTER_API_KEY` kullanır.

[Models CLI](/cli/models).

### 9. Konuşma (speech)

Konuşma modu, yapılandırıldığında **ElevenLabs** çağırabilir:

- `ELEVENLABS_API_KEY` veya `talk.apiKey`

[Konuşma modu](/nodes/talk).

### 10. Skills (üçüncü taraf API’ler)

Skills, `apiKey`’ü `skills.entries.<name>.apiKey` içinde saklayabilir. Bir skill bu anahtarı harici
API’ler için kullanırsa, skill’in sağlayıcısına göre maliyet oluşturabilir.

[Skills](/tools/skills).
