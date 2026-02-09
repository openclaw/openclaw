---
summary: "Ajan çalışma zamanı (gömülü pi-mono), çalışma alanı sözleşmesi ve oturum önyüklemesi"
read_when:
  - Changing agent runtime, workspace bootstrap, or session behavior
title: "Agent Runtime"
---

# Agent Runtime 🤖

OpenClaw, **pi-mono**’dan türetilmiş tek bir gömülü ajan çalışma zamanı çalıştırır.

## Çalışma Alanı (gerekli)

OpenClaw, araçlar ve bağlam için ajanın **tek** çalışma dizini (`cwd`) olarak tek bir ajan çalışma alanı dizini (`agents.defaults.workspace`) kullanır.

Önerilen: eksikse `~/.openclaw/openclaw.json` oluşturmak ve çalışma alanı dosyalarını başlatmak için `openclaw setup` kullanın.

Tam çalışma alanı düzeni + yedekleme kılavuzu: [Ajan çalışma alanı](/concepts/agent-workspace)

`agents.defaults.sandbox` etkinse, ana olmayan oturumlar bunu `agents.defaults.sandbox.workspaceRoot` altında
oturum başına çalışma alanlarıyla geçersiz kılabilir (bkz.
[Gateway yapılandırması](/gateway/configuration)).

## Bootstrap files (injected)

`agents.defaults.workspace` içinde OpenClaw, kullanıcı tarafından düzenlenebilir şu dosyaları bekler:

- `AGENTS.md` — işletim talimatları + “hafıza”
- `SOUL.md` — persona, sınırlar, ton
- `TOOLS.md` — kullanıcı tarafından tutulan araç notları (örn. `imsg`, `sag`, kurallar)
- `BOOTSTRAP.md` — tek seferlik ilk çalıştırma ritüeli (tamamlandıktan sonra silinir)
- `IDENTITY.md` — ajan adı/vibe/emoji
- `USER.md` — kullanıcı profili + tercih edilen hitap

Yeni bir oturumun ilk turunda OpenClaw, bu dosyaların içeriklerini doğrudan ajan bağlamına enjekte eder.

Boş dosyalar atlanır. Büyük dosyalar, istemler yalın kalsın diye bir işaretle kırpılır ve kısaltılır (tam içerik için dosyayı okuyun).

Bir dosya eksikse, OpenClaw tek bir “eksik dosya” işaret satırı enjekte eder (ve `openclaw setup` güvenli bir varsayılan şablon oluşturur).

`BOOTSTRAP.md` yalnızca **yepyeni bir çalışma alanı** için (başka önyükleme dosyası yokken) oluşturulur. Ritüeli tamamladıktan sonra silerseniz, sonraki yeniden başlatmalarda yeniden oluşturulmamalıdır.

Önyükleme dosyası oluşturmayı tamamen devre dışı bırakmak için (önceden tohumlanmış çalışma alanları için) şunu ayarlayın:

```json5
{ agent: { skipBootstrap: true } }
```

## Yerleşik araçlar

Çekirdek araçlar (okuma/çalıştırma/düzenleme/yazma ve ilgili sistem araçları) araç politikasına tabi olarak her zaman kullanılabilir. `apply_patch` isteğe bağlıdır ve `tools.exec.applyPatch` tarafından kapatılır/açılır. `TOOLS.md` hangi araçların var olduğunu **kontrol etmez**; onları nasıl kullanmak istediğinize dair bir yönlendirmedir.

## Skills

OpenClaw, Skills’leri üç konumdan yükler (ad çakışmasında çalışma alanı kazanır):

- Paketlenmiş (kurulumla birlikte gelir)
- Yönetilen/yerel: `~/.openclaw/skills`
- Çalışma alanı: `<workspace>/skills`

Skills, yapılandırma/ortam değişkenleriyle kapatılabilir (bkz. [Gateway yapılandırması](/gateway/configuration) içindeki `skills`).

## pi-mono entegrasyonu

OpenClaw, pi-mono kod tabanının bazı parçalarını (modeller/araçlar) yeniden kullanır; ancak **oturum yönetimi, keşif ve araç bağlama OpenClaw’a aittir**.

- pi-coding ajan çalışma zamanı yoktur.
- `~/.pi/agent` veya `<workspace>/.pi` ayarları dikkate alınmaz.

## Sessions

Oturum dökümleri JSONL olarak şurada saklanır:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

Oturum kimliği sabittir ve OpenClaw tarafından seçilir.
Eski Pi/Tau oturum klasörleri **okunmaz**.

## Akış sırasında yönlendirme

Kuyruk modu `steer` iken, gelen mesajlar mevcut çalışmaya enjekte edilir.
Kuyruk **her araç çağrısından sonra** kontrol edilir; kuyrukta bir mesaj varsa,
mevcut asistan mesajındaki kalan araç çağrıları atlanır (“Queued user message nedeniyle atlandı.” hata aracı sonuçlarıyla), ardından bir sonraki asistan yanıtından önce kuyruktaki kullanıcı mesajı enjekte edilir.

Kuyruk modu `followup` veya `collect` iken, gelen mesajlar mevcut tur bitene kadar tutulur; ardından kuyruktaki yüklerle yeni bir ajan turu başlar. Mod + debounce/cap davranışı için [Queue](/concepts/queue) sayfasına bakın.

Blok halinde akış, tamamlanan asistan bloklarını biter bitmez gönderir; **varsayılan olarak kapalıdır** (`agents.defaults.blockStreamingDefault: "off"`).
Sınırı `agents.defaults.blockStreamingBreak` ile ayarlayın (`text_end` vs `message_end`; varsayılan text_end).
Yumuşak blok parçalamasını `agents.defaults.blockStreamingChunk` ile kontrol edin (varsayılan
800–1200 karakter; paragraf sonlarını, ardından satır sonlarını tercih eder; en son cümleler).
Tek satır spam’ini azaltmak için `agents.defaults.blockStreamingCoalesce` ile akış parçalarını birleştirin
(göndermeden önce boşta kalmaya dayalı birleştirme). Telegram dışı kanallar, blok yanıtlarını etkinleştirmek için açıkça `*.blockStreaming: true` gerektirir.
Ayrıntılı araç özetleri araç başlangıcında yayımlanır (debounce yoktur); Control UI, mümkün olduğunda ajan olayları üzerinden araç çıktısını akıtır.
Daha fazla ayrıntı: [Akış + parçalama](/concepts/streaming).

## Model referansları

Yapılandırmadaki model referansları (örneğin `agents.defaults.model` ve `agents.defaults.models`), **ilk** `/` üzerinden bölünerek ayrıştırılır.

- Modelleri yapılandırırken `provider/model` kullanın.
- Model kimliğinin kendisi `/` (OpenRouter tarzı) içeriyorsa, sağlayıcı önekini ekleyin (örnek: `openrouter/moonshotai/kimi-k2`).
- Sağlayıcıyı atarsanız, OpenClaw girdiyi bir takma ad veya **varsayılan sağlayıcı** için bir model olarak ele alır (yalnızca model kimliğinde `/` yoksa çalışır).

## Yapılandırma (asgari)

En azından şunları ayarlayın:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (şiddetle önerilir)

---

_Sonraki: [Grup Sohbetleri](/channels/group-messages)_ 🦞
