---
summary: "Test kiti: unit/e2e/canlı paketler, Docker çalıştırıcıları ve her testin neleri kapsadığı"
read_when:
  - Testleri yerelde veya CI’da çalıştırırken
  - Model/sağlayıcı hataları için regresyon eklerken
  - 50. Gateway + ajan davranışını hata ayıklama
title: "Testler"
---

# Testler

OpenClaw’da üç Vitest paketi (unit/integration, e2e, canlı) ve küçük bir Docker çalıştırıcı seti vardır.

Bu belge bir “nasıl test ediyoruz” kılavuzudur:

- Hangi paketi çalıştırmalıyım?
- Yaygın iş akışları için hangi komutların çalıştırılacağı (yerel, push öncesi, hata ayıklama)
- Canlı testlerin kimlik bilgilerini nasıl keşfettiği ve model/sağlayıcıları nasıl seçtiği
- Gerçek dünyadaki model/sağlayıcı sorunları için regresyonların nasıl ekleneceği

## Hızlı başlangıç

Çoğu gün:

- Tam kapı (push öncesi beklenen): `pnpm build && pnpm check && pnpm test`

Testlere dokunduğunuzda veya ekstra güven istediğinizde:

- Kapsam kapısı: `pnpm test:coverage`
- E2E paketi: `pnpm test:e2e`

Gerçek sağlayıcıları/modelleri hata ayıklarken (gerçek kimlik bilgileri gerekir):

- Canlı paket (modeller + gateway araç/görüntü probları): `pnpm test:live`

İpucu: yalnızca tek bir başarısız vakaya ihtiyacınız olduğunda, aşağıda açıklanan izin listesi ortam değişkenleriyle canlı testleri daraltmayı tercih edin.

## Test paketleri (nerede ne çalışır)

Paketleri “artan gerçekçilik” (ve artan oynaklık/maliyet) olarak düşünün:

### Unit / integration (varsayılan)

- Komut: `pnpm test`
- Yapılandırma: `vitest.config.ts`
- Dosyalar: `src/**/*.test.ts`
- Kapsam:
  - Saf unit testleri
  - Süreç içi entegrasyon testleri (gateway kimlik doğrulama, yönlendirme, araçlar, ayrıştırma, yapılandırma)
  - Bilinen hatalar için deterministik regresyonlar
- Beklentiler:
  - CI’da çalışır
  - Gerçek anahtarlar gerekmez
  - Hızlı ve kararlı olmalıdır

### E2E (gateway duman testi)

- Komut: `pnpm test:e2e`
- Yapılandırma: `vitest.e2e.config.ts`
- Dosyalar: `src/**/*.e2e.test.ts`
- Kapsam:
  - Çok örnekli gateway uçtan uca davranışı
  - WebSocket/HTTP yüzeyleri, düğüm eşleştirme ve daha ağır ağ işlemleri
- Beklentiler:
  - CI’da çalışır (hatta boru hattında etkinleştirildiğinde)
  - Gerçek anahtarlar gerekmez
  - Unit testlerine göre daha fazla hareketli parça (daha yavaş olabilir)

### Canlı (gerçek sağlayıcılar + gerçek modeller)

- Komut: `pnpm test:live`
- Yapılandırma: `vitest.live.config.ts`
- Dosyalar: `src/**/*.live.test.ts`
- Varsayılan: `pnpm test:live` tarafından **etkin** ( `OPENCLAW_LIVE_TEST=1` ayarlanır)
- Kapsam:
  - “Bu sağlayıcı/model _bugün_ gerçek kimlik bilgileriyle gerçekten çalışıyor mu?”
  - Sağlayıcı format değişiklikleri, araç çağırma tuhaflıkları, kimlik doğrulama sorunları ve oran sınırlaması davranışlarını yakalar
- Beklentiler:
  - Tasarım gereği CI’da kararlı değildir (gerçek ağlar, gerçek sağlayıcı politikaları, kotalar, kesintiler)
  - Maliyetlidir / oran sınırlarını kullanır
  - “Her şey” yerine daraltılmış alt kümeler çalıştırmayı tercih edin
  - Canlı çalıştırmalar, eksik API anahtarlarını almak için `~/.profile`’i kaynak alır
  - Anthropic anahtar rotasyonu: `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (veya `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) ya da birden çok `ANTHROPIC_API_KEY*` değişkeni ayarlayın; testler oran sınırlarında yeniden dener

## görüntü yoklamasını çalıştırmak için.

Bu karar tablosunu kullanın:

- Mantık/test düzenliyorsanız: `pnpm test` (çok şey değiştirdiyseniz `pnpm test:coverage`)
- Gateway ağ iletişimi / WS protokolü / eşleştirme ile oynuyorsanız: `pnpm test:e2e` ekleyin
- “Botum çalışmıyor” / sağlayıcıya özgü hatalar / araç çağırma hata ayıklaması: daraltılmış bir `pnpm test:live` çalıştırın

## Canlı: model duman testi (profil anahtarları)

Canlı testler, hataları izole edebilmek için iki katmana ayrılır:

- “Doğrudan model”, verilen anahtarla sağlayıcı/modelin en azından yanıt verebildiğini söyler.
- “Gateway duman testi”, tam gateway+ajan hattının bu model için çalıştığını söyler (oturumlar, geçmiş, araçlar, sandbox politikası vb.).

### Katman 1: Doğrudan model tamamlaması (gateway yok)

- Test: `src/agents/models.profiles.live.test.ts`
- Amaç:
  - Keşfedilen modelleri listelemek
  - Kimlik bilgisine sahip olduğunuz modelleri seçmek için `getApiKeyForModel` kullanmak
  - Model başına küçük bir tamamlama (ve gerektiğinde hedefli regresyonlar) çalıştırmak
- Nasıl etkinleştirilir:
  - `pnpm test:live` (veya Vitest’i doğrudan çağırıyorsanız `OPENCLAW_LIVE_TEST=1`)
- Bu paketi gerçekten çalıştırmak için `OPENCLAW_LIVE_MODELS=modern` (veya modern için takma ad `all`) ayarlayın; aksi halde `pnpm test:live`’yi gateway duman testine odaklı tutmak için atlanır
- Modeller nasıl seçilir:
  - Modern izin listesini çalıştırmak için `OPENCLAW_LIVE_MODELS=modern` (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` modern izin listesi için bir takma addır
  - veya `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (virgülle ayrılmış izin listesi)
- Sağlayıcılar nasıl seçilir:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (virgülle ayrılmış izin listesi)
- Anahtarlar nereden gelir:
  - Varsayılan: profil deposu ve ortam değişkeni yedekleri
  - **Yalnızca profil deposu**nu zorlamak için `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` ayarlayın
- Neden var:
  - “Sağlayıcı API’si bozuk / anahtar geçersiz” ile “gateway ajan hattı bozuk” ayrımını yapar
  - Küçük, izole regresyonlar içerir (örnek: OpenAI Responses/Codex Responses akıl yürütme tekrar oynatma + araç çağırma akışları)

### Katman 2: Gateway + geliştirme ajanı duman testi (“@openclaw” gerçekte ne yapar)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Amaç:
  - Süreç içi bir gateway başlatmak
  - Bir `agent:dev:*` oturumu oluşturmak/yamalamak (çalıştırma başına model geçersiz kılma)
  - Anahtarı olan modelleri dolaşıp şunları doğrulamak:
    - “anlamlı” yanıt (araç yok)
    - gerçek bir araç çağrısının çalışması (okuma probu)
    - isteğe bağlı ek araç probları (çalıştırma+okuma probu)
    - OpenAI regresyon yollarının (yalnızca araç çağrısı → takip) çalışmaya devam etmesi
- Prob ayrıntıları (hataları hızlıca açıklayabilmeniz için):
  - `read` probu: test, çalışma alanında bir nonce dosyası yazar ve ajandan onu `read` ve nonce’u geri yankılamasını ister.
  - `exec+read` probu: test, ajandan bir nonce’u geçici bir dosyaya `exec`-yazmasını, ardından onu `read` ister.
  - Görüntü probu: test, üretilmiş bir PNG’yi (kedi + rastgele kod) ekler ve modelden `cat <CODE>` döndürmesini bekler.
  - Uygulama referansı: `src/gateway/gateway-models.profiles.live.test.ts` ve `src/gateway/live-image-probe.ts`.
- Nasıl etkinleştirilir:
  - `pnpm test:live` (veya Vitest’i doğrudan çağırıyorsanız `OPENCLAW_LIVE_TEST=1`)
- Modeller nasıl seçilir:
  - Varsayılan: modern izin listesi (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` modern izin listesi için bir takma addır
  - Ya da daraltmak için `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (veya virgülle ayrılmış liste) ayarlayın
- Sağlayıcılar nasıl seçilir (“OpenRouter her şey”den kaçının):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (virgülle ayrılmış izin listesi)
- Araç + görüntü probları bu canlı testte her zaman açıktır:
  - `read` probu + `exec+read` probu (araç stresi)
  - Görüntü probu, model görüntü girdisi desteği bildirdiğinde çalışır
  - Akış (üst düzey):
    - Test, “CAT” + rastgele kod içeren küçük bir PNG üretir (`src/gateway/live-image-probe.ts`)
    - Bunu `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]` üzerinden gönderir
    - Gateway, ekleri `images[]` içine ayrıştırır (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Gömülü ajan, modele çok kipli bir kullanıcı mesajı iletir
    - Doğrulama: yanıt `cat` + kodu içerir (OCR toleransı: küçük hatalara izin verilir)

İpucu: Makinenizde neleri test edebileceğinizi (ve tam `provider/model` kimliklerini) görmek için şunu çalıştırın:

```bash
openclaw models list
openclaw models list --json
```

## Canlı: Anthropic setup-token duman testi

- Test: `src/agents/anthropic.setup-token.live.test.ts`
- Amaç: Claude Code CLI setup-token’ının (veya yapıştırılmış bir setup-token profilinin) bir Anthropic istemini tamamlayabildiğini doğrulamak.
- Etkinleştirme:
  - `pnpm test:live` (veya Vitest’i doğrudan çağırıyorsanız `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Belirteç kaynakları (birini seçin):
  - Profil: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Ham belirteç: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Model geçersiz kılma (isteğe bağlı):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Kurulum örneği:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Canlı: CLI arka uç duman testi (Claude Code CLI veya diğer yerel CLI’ler)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Amaç: Varsayılan yapılandırmanıza dokunmadan, yerel bir CLI arka ucu kullanarak Gateway + ajan hattını doğrulamak.
- Etkinleştirme:
  - `pnpm test:live` (veya Vitest’i doğrudan çağırıyorsanız `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Varsayılanlar:
  - Model: `claude-cli/claude-sonnet-4-5`
  - Komut: `claude`
  - Argümanlar: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Geçersiz kılmalar (isteğe bağlı):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - Gerçek bir görüntü eki göndermek için `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` (yollar isteme enjekte edilir).
  - Görüntü dosya yollarını isteme enjekte etmek yerine CLI argümanı olarak geçirmek için `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"`.
  - `IMAGE_ARG` ayarlı olduğunda görüntü argümanlarının nasıl geçirileceğini denetlemek için `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (veya `"list"`).
  - İkinci bir tur göndermek ve devam akışını doğrulamak için `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1`.
- Claude Code CLI MCP yapılandırmasını etkin tutmak için `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` (varsayılan, MCP yapılandırmasını geçici boş bir dosya ile devre dışı bırakır).

Örnek:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Önerilen canlı tarifler

Dar ve açık izin listeleri en hızlı ve en az oynaktır:

- Tek model, doğrudan (gateway yok):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Tek model, gateway duman testi:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Birden çok sağlayıcıda araç çağırma:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google odak (Gemini API anahtarı + Antigravity):
  - Gemini (API anahtarı): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Notlar:

- `google/...` Gemini API’sini kullanır (API anahtarı).
- `google-antigravity/...` Antigravity OAuth köprüsünü kullanır (Cloud Code Assist tarzı ajan uç noktası).
- `google-gemini-cli/...` makinenizdeki yerel Gemini CLI’yi kullanır (ayrı kimlik doğrulama + araçlama tuhaflıkları).
- Gemini API vs Gemini CLI:
  - API: OpenClaw, Google’ın barındırılan Gemini API’sini HTTP üzerinden çağırır (API anahtarı / profil kimlik doğrulaması); çoğu kullanıcının “Gemini” derken kastettiği budur.
  - CLI: OpenClaw, yerel bir `gemini` ikilisini kabuk üzerinden çağırır; kendi kimlik doğrulaması vardır ve farklı davranabilir (akış/araç desteği/sürüm uyumsuzluğu).

## Canlı: model matrisi (neyi kapsıyoruz)

Sabit bir “CI model listesi” yoktur (canlı testler isteğe bağlıdır), ancak bunlar anahtarları olan bir geliştirici makinesinde düzenli olarak kapsanması **önerilen** modellerdir.

### Modern duman seti (araç çağırma + görüntü)

Çalışır durumda kalmasını beklediğimiz “yaygın modeller” çalıştırmasıdır:

- OpenAI (Codex olmayan): `openai/gpt-5.2` (isteğe bağlı: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (isteğe bağlı: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (veya `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` ve `google/gemini-3-flash-preview` (eski Gemini 2.x modellerinden kaçının)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` ve `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Araçlar + görüntü ile gateway duman testini çalıştırın:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Temel çizgi: araç çağırma (Okuma + isteğe bağlı Çalıştırma)

Her sağlayıcı ailesinden en az birini seçin:

- OpenAI: `openai/gpt-5.2` (veya `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (veya `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (veya `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

İsteğe bağlı ek kapsama (olsa iyi olur):

- xAI: `xai/grok-4` (veya mevcut en güncel)
- Mistral: `mistral/`… (etkinleştirdiğiniz “tools” yetenekli bir model seçin)
- Cerebras: `cerebras/`… (erişiminiz varsa)
- LM Studio: `lmstudio/`… (yerel; araç çağırma API moduna bağlıdır)

### Görsel: görüntü gönderimi (ek → çok kipli mesaj)

Görüntü probunu çalıştırmak için `OPENCLAW_LIVE_GATEWAY_MODELS` içinde en az bir görüntü destekli model (Claude/Gemini/OpenAI görsel varyantları vb.) Kullanışlı ortam değişkenleri:

### Toplayıcılar / alternatif gateway’ler

Anahtarlarınız etkinse, şu yollarla da test etmeyi destekliyoruz:

- OpenRouter: `openrouter/...` (yüzlerce model; araç+görüntü destekli adayları bulmak için `openclaw models scan` kullanın)
- OpenCode Zen: `opencode/...` (`OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` ile kimlik doğrulama)

Canlı matrise ekleyebileceğiniz daha fazla sağlayıcı (kimlik bilgisi/yapılandırmanız varsa):

- Yerleşik: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- `models.providers` üzerinden (özel uç noktalar): `minimax` (bulut/API) ve OpenAI/Anthropic uyumlu herhangi bir proxy (LM Studio, vLLM, LiteLLM vb.)

İpucu: Belgelerde “tüm modeller”i sabitlemeye çalışmayın. Yetkili liste, makinenizde `discoverModels(...)`’nin döndürdüğü her şey + mevcut anahtarlarınızdır.

## Kimlik bilgileri (asla commit etmeyin)

Canlı testler, kimlik bilgilerini CLI ile aynı şekilde keşfeder. Pratik sonuçlar:

- CLI çalışıyorsa, canlı testler de aynı anahtarları bulmalıdır.

- Bir canlı test “kimlik bilgisi yok” diyorsa, `openclaw models list` / model seçimini nasıl hata ayıklıyorsanız aynı şekilde hata ayıklayın.

- Profil deposu: `~/.openclaw/credentials/` (tercih edilir; testlerde “profil anahtarları”nın anlamı budur)

- Yapılandırma: `~/.openclaw/openclaw.json` (veya `OPENCLAW_CONFIG_PATH`)

Ortam anahtarlarına (ör. `~/.profile`’inizde dışa aktarılmış) güvenmek istiyorsanız, yerel testleri `source ~/.profile`’den sonra çalıştırın veya aşağıdaki Docker çalıştırıcılarını kullanın (kapsayıcıya `~/.profile` bağlayabilirler).

## Deepgram canlı (ses deşifre)

- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Etkinleştirme: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker çalıştırıcıları (isteğe bağlı “Linux’ta çalışıyor” kontrolleri)

Bunlar, depo Docker imajı içinde `pnpm test:live` çalıştırır; yerel yapılandırma dizininizi ve çalışma alanını bağlar (bağlandıysa `~/.profile`’yi kaynak alır):

- Doğrudan modeller: `pnpm test:docker:live-models` (betik: `scripts/test-live-models-docker.sh`)
- Gateway + geliştirme ajanı: `pnpm test:docker:live-gateway` (betik: `scripts/test-live-gateway-models-docker.sh`)
- İlk katılım sihirbazı (TTY, tam iskelet): `pnpm test:docker:onboard` (betik: `scripts/e2e/onboard-docker.sh`)
- Gateway ağ iletişimi (iki kapsayıcı, WS kimlik doğrulama + sağlık): `pnpm test:docker:gateway-network` (betik: `scripts/e2e/gateway-network-docker.sh`)
- Eklentiler (özel uzantı yükleme + kayıt defteri duman testi): `pnpm test:docker:plugins` (betik: `scripts/e2e/plugins-docker.sh`)

Doküman tutarlılığı

- `OPENCLAW_CONFIG_DIR=...` (varsayılan: `~/.openclaw`) → `/home/node/.openclaw`’e bağlanır
- `OPENCLAW_WORKSPACE_DIR=...` (varsayılan: `~/.openclaw/workspace`) → `/home/node/.openclaw/workspace`’e bağlanır
- `OPENCLAW_PROFILE_FILE=...` (varsayılan: `~/.profile`) → `/home/node/.profile`’ya bağlanır ve testler çalışmadan önce kaynak alınır
- Çalıştırmayı daraltmak için `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...`
- Kimlik bilgilerinin ortamdan değil profil deposundan gelmesini sağlamak için `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1`

## Temel yetenekler

Belge düzenlemelerinden sonra belge kontrollerini çalıştırın: `pnpm docs:list`.

## Çevrimdışı regresyon (CI-güvenli)

Bunlar, gerçek sağlayıcılar olmadan “gerçek hat” regresyonlarıdır:

- Gateway araç çağırma (mock OpenAI, gerçek gateway + ajan döngüsü): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway sihirbazı (WS `wizard.start`/`wizard.next`, yapılandırma yazar + kimlik doğrulama zorunlu): `src/gateway/gateway.wizard.e2e.test.ts`

## Ajan güvenilirliği değerlendirmeleri (skills)

Halihazırda “ajan güvenilirliği değerlendirmeleri” gibi davranan bazı CI-güvenli testlerimiz var:

- Gerçek gateway + ajan döngüsü üzerinden mock araç çağırma (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- Oturum kablolamasını ve yapılandırma etkilerini doğrulayan uçtan uca sihirbaz akışları (`src/gateway/gateway.wizard.e2e.test.ts`).

Skills için hâlâ eksik olanlar ([Skills](/tools/skills)’e bakın):

- **Karar verme:** istemde skills listelendiğinde, ajan doğru skill’i seçiyor mu (ya da alakasız olanlardan kaçınıyor mu)?
- **Uyumluluk:** ajan, kullanımdan önce `SKILL.md`’yi okuyor mu ve gerekli adımları/argümanları izliyor mu?
- **İş akışı sözleşmeleri:** araç sırası, oturum geçmişi taşınması ve sandbox sınırlarını doğrulayan çok turlu senaryolar.

Gelecek değerlendirmeler önce deterministik kalmalıdır:

- Araç çağrılarını + sıralamayı, skill dosyası okumalarını ve oturum kablolamasını doğrulamak için mock sağlayıcılar kullanan bir senaryo çalıştırıcı.
- Skill odaklı küçük bir senaryo paketi (kullan vs kaçın, kapılama, isteme enjeksiyonu).
- CI-güvenli paket yerleştirildikten sonra yalnızca isteğe bağlı (opt-in, env ile kapılı) canlı değerlendirmeler.

## Regresyon ekleme (rehber)

Canlıda keşfedilen bir sağlayıcı/model sorununu düzelttiğinizde:

- Mümkünse CI-güvenli bir regresyon ekleyin (sağlayıcıyı mock’layın/stub’layın veya tam istek-şekli dönüşümünü yakalayın)
- Doğası gereği yalnızca canlıysa (oran sınırları, kimlik doğrulama politikaları), canlı testi dar tutun ve env değişkenleriyle opt-in yapın
- Hatayı yakalayan en küçük katmanı hedeflemeyi tercih edin:
  - sağlayıcı istek dönüştürme/yeniden oynatma hatası → doğrudan modeller testi
  - gateway oturum/geçmiş/araç hattı hatası → gateway canlı duman testi veya CI-güvenli gateway mock testi
