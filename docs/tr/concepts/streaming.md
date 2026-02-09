---
summary: "Streaming + parçalama davranışı (blok yanıtlar, taslak streaming, sınırlar)"
read_when:
  - Kanallarda streaming veya parçalamanın nasıl çalıştığını açıklarken
  - Blok streaming veya kanal parçalama davranışını değiştirirken
  - Yinelenen/erken blok yanıtları ya da taslak streaming’i hata ayıklarken
title: "Streaming ve Parçalama"
---

# Streaming + parçalama

OpenClaw’da iki ayrı “streaming” katmanı vardır:

- **Blok streaming (kanallar):** asistan yazdıkça tamamlanmış **blokları** yayar. Bunlar normal kanal mesajlarıdır (token deltaları değildir).
- **Token-benzeri streaming (yalnızca Telegram):** üretim sırasında **taslak baloncuğu** kısmi metinle günceller; son mesaj en sonda gönderilir.

Günümüzde harici kanal mesajlarına **gerçek token streaming** yoktur. Telegram taslak streaming’i tek kısmi-stream yüzeyidir.

## Blok streaming (kanal mesajları)

Blok streaming, asistan çıktısını kullanılabilir oldukça kaba parçalara bölerek gönderir.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legend:

- `text_delta/events`: model stream olayları (streaming olmayan modellerde seyrek olabilir).
- `chunker`: min/max sınırları + bölme tercihini uygulayan `EmbeddedBlockChunker`.
- `channel send`: gerçek giden mesajlar (blok yanıtlar).

**Kontroller:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (varsayılan kapalı).
- Kanal geçersiz kılmaları: kanal başına `"on"`/`"off"` zorlamak için `*.blockStreaming` (ve hesap başına varyantlar).
- `agents.defaults.blockStreamingBreak`: `"text_end"` veya `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (göndermeden önce stream edilen blokları birleştir).
- Kanal sert sınırı: `*.textChunkLimit` (örn. `channels.whatsapp.textChunkLimit`).
- Kanal parça modu: `*.chunkMode` (`length` varsayılan, `newline` uzunlukla parçalamadan önce boş satırlarda (paragraf sınırları) böler).
- Discord yumuşak sınırı: `channels.discord.maxLinesPerMessage` (varsayılan 17) UI kırpılmasını önlemek için uzun yanıtları böler.

**Sınır semantiği:**

- `text_end`: parçalayıcı yayınladığı anda stream blokları gönder; her `text_end`’da flush et.
- `message_end`: asistan mesajı bitene kadar bekle, ardından arabelleğe alınan çıktıyı gönder.

`message_end`, arabelleğe alınan metin `maxChars`’yi aşarsa yine parçalayıcıyı kullanır; bu nedenle sonunda birden fazla parça gönderebilir.

## Parçalama algoritması (alt/üst sınırlar)

Blok parçalama `EmbeddedBlockChunker` tarafından uygulanır:

- **Alt sınır:** arabellek >= `minChars` olana kadar gönderme (zorlanmadıkça).
- **Üst sınır:** `maxChars`’den önce bölmeyi tercih et; zorlanırsa `maxChars`’te böl.
- **Bölme tercihi:** `paragraph` → `newline` → `sentence` → `whitespace` → sert bölme.
- **Kod çitleri:** çitlerin içinde asla bölme; `maxChars`’te zorlanırsa Markdown geçerli kalsın diye çiti kapat + yeniden aç.

`maxChars`, kanal `textChunkLimit`’ına sıkıştırılır; yani kanal başına sınırları aşamazsınız.

## Birleştirme (stream edilen blokları birleştir)

Blok streaming etkin olduğunda OpenClaw, göndermeden önce **ardışık blok parçalarını birleştirebilir**. Bu, ilerlemeli çıktı sağlarken “tek satırlık spam”i azaltır.

- Birleştirme, flush etmeden önce **boşta kalma aralıklarını** (`idleMs`) bekler.
- Arabellekler `maxChars` ile sınırlandırılır ve aşılırsa gönderilir.
- `minChars`, yeterli metin birikene kadar çok küçük parçaların gönderilmesini engeller
  (son flush her zaman kalan metni gönderir).
- Birleştirici, `blockStreamingChunk.breakPreference`’ten türetilir
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → boşluk).
- Kanal geçersiz kılmaları `*.blockStreamingCoalesce` üzerinden kullanılabilir (hesap başına yapılandırmalar dahil).
- Varsayılan birleştirme `minChars`, Signal/Slack/Discord için geçersiz kılınmadıkça 1500’e yükseltilir.

## Bloklar arasında insan benzeri tempo

Blok streaming etkin olduğunda, blok yanıtları arasında (**ilk bloktan sonra**) **rastgele bir duraklama** ekleyebilirsiniz. Bu, çok baloncuklu yanıtların daha doğal hissetmesini sağlar.

- Yapılandırma: `agents.defaults.humanDelay` (ajan başına `agents.list[].humanDelay` ile geçersiz kılınabilir).
- Modlar: `off` (varsayılan), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).
- Yalnızca **blok yanıtları** için geçerlidir; final yanıtlar veya araç özetleri için geçerli değildir.

## “Parçaları stream et veya her şeyi gönder”

This maps to:

- **Parçaları stream et:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (ilerledikçe gönder). Telegram dışı kanallar ayrıca `*.blockStreaming: true` gerektirir.
- **Her şeyi sonda stream et:** `blockStreamingBreak: "message_end"` (bir kez flush et; çok uzunsa birden fazla parça olabilir).
- **Blok streaming yok:** `blockStreamingDefault: "off"` (yalnızca final yanıt).

**Kanal notu:** Telegram dışı kanallar için blok streaming, `*.blockStreaming` açıkça `true` olarak ayarlanmadıkça **kapalıdır**. Telegram, blok yanıtlar olmadan taslakları stream edebilir
(`channels.telegram.streamMode`).

Yapılandırma konumu hatırlatıcısı: `blockStreaming*` varsayılanları
kök yapılandırmada değil, `agents.defaults` altında bulunur.

## Telegram taslak streaming (token-benzeri)

Telegram, taslak streaming’e sahip tek kanaldır:

- **Konulu özel sohbetlerde** Bot API `sendMessageDraft`’u kullanır.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: en son stream metniyle taslak güncellemeleri.
  - `block`: parçalı bloklar halinde taslak güncellemeleri (aynı parçalayıcı kuralları).
  - `off`: taslak streaming yok.
- Taslak parça yapılandırması (yalnızca `streamMode: "block"` için): `channels.telegram.draftChunk` (varsayılanlar: `minChars: 200`, `maxChars: 800`).
- Taslak streaming, blok streaming’den ayrıdır; blok yanıtlar varsayılan olarak kapalıdır ve Telegram dışı kanallarda yalnızca `*.blockStreaming: true` ile etkinleştirilir.
- Final yanıt yine normal bir mesajdır.
- `/reasoning stream`, akıl yürütmeyi taslak baloncuğuna yazar (yalnızca Telegram).

Taslak streaming etkin olduğunda, OpenClaw çift streaming’i önlemek için o yanıt için blok streaming’i devre dışı bırakır.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legend:

- `sendMessageDraft`: Telegram taslak baloncuğu (gerçek bir mesaj değildir).
- `final reply`: normal Telegram mesaj gönderimi.
