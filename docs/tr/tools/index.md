---
summary: "Eski `openclaw-*` skills’lerin yerini alan OpenClaw için ajan araç yüzeyi (tarayıcı, canvas, düğümler, mesaj, cron)"
read_when:
  - Ajan araçlarını eklerken veya değiştirirken
  - "`openclaw-*` skills’leri emekliye ayırırken veya değiştirirken"
title: "Araçlar"
---

# Araçlar (OpenClaw)

OpenClaw; tarayıcı, canvas, düğümler ve cron için **birinci sınıf ajan araçları** sunar.
Bunlar eski `openclaw-*` skills’lerinin yerini alır: araçlar tip güvenlidir, shell’e çıkmaz
ve ajan bunlara doğrudan güvenmelidir.

## Araçları devre dışı bırakma

Araçları `openclaw.json` içinde `tools.allow` / `tools.deny` üzerinden küresel olarak izin verilebilir/engellenebilir
(engelleme önceliklidir). Bu, izin verilmeyen araçların model sağlayıcılarına gönderilmesini önler.

```json5
{
  tools: { deny: ["browser"] },
}
```

Notlar:

- 27. Eşleştirme büyük/küçük harfe duyarsızdır.
- `*` joker karakterleri desteklenir (`"*"` tüm araçlar anlamına gelir).
- `tools.allow` yalnızca bilinmeyen veya yüklenmemiş eklenti araç adlarına atıfta bulunuyorsa, OpenClaw bir uyarı kaydeder ve çekirdek araçlar kullanılabilir kalsın diye izin listesini yok sayar.

## Araç profilleri (temel izin listesi)

`tools.profile`, `tools.allow`/`tools.deny`’ten önce **temel bir araç izin listesi** belirler.
Ajan bazında geçersiz kılma: `agents.list[].tools.profile`.

Profiller:

- `minimal`: yalnızca `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: kısıtlama yok (ayarlanmamış ile aynı)

Örnek (varsayılan olarak yalnızca mesajlaşma, ayrıca Slack + Discord araçlarına izin ver):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Örnek (kodlama profili, ancak her yerde exec/process’i engelle):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Örnek (küresel kodlama profili, yalnızca mesajlaşma destek ajanı):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Sağlayıcıya özgü araç politikası

Küresel varsayılanlarınızı değiştirmeden belirli sağlayıcılar
(veya tek bir `provider/model`) için araçları **daha da kısıtlamak** üzere `tools.byProvider` kullanın.
Ajan bazında geçersiz kılma: `agents.list[].tools.byProvider`.

Bu, temel araç profilinden **sonra** ve izin/verme listelerinden **önce** uygulanır,
dolayısıyla araç kümesini yalnızca daraltabilir.
Sağlayıcı anahtarları ya `provider` (ör. `google-antigravity`) ya da
`provider/model` (ör. `openai/gpt-5.2`) kabul eder.

Örnek (küresel kodlama profilini koru, ancak Google Antigravity için minimal araçlar):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Örnek (sorunlu bir uç nokta için sağlayıcı/model‑özel izin listesi):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

Örnek (tek bir sağlayıcı için ajan‑özel geçersiz kılma):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Araç grupları (kısayollar)

Araç politikaları (küresel, ajan, sandbox) birden çok araca açılan `group:*` girdilerini destekler.
Bunları `tools.allow` / `tools.deny` içinde kullanın.

Mevcut gruplar:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: tüm yerleşik OpenClaw araçları (sağlayıcı eklentileri hariç)

Örnek (yalnızca dosya araçları + tarayıcıya izin ver):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Eklentiler + araçlar

Eklentiler, çekirdek kümenin ötesinde **ek araçlar** (ve CLI komutları) kaydedebilir.
Kurulum + yapılandırma için [Plugins](/tools/plugin), araç kullanım rehberliğinin
istemlere nasıl enjekte edildiği için [Skills](/tools/skills) bölümüne bakın. Bazı eklentiler, araçların yanında kendi skills’lerini de sunar
(örneğin sesli arama eklentisi).

İsteğe bağlı eklenti araçları:

- [Lobster](/tools/lobster): devam ettirilebilir onaylara sahip tipli iş akışı çalışma zamanı (gateway ana makinesinde Lobster CLI gerektirir).
- [LLM Task](/tools/llm-task): yapılandırılmış iş akışı çıktısı için yalnızca JSON LLM adımı (isteğe bağlı şema doğrulama).

## 28. Araç envanteri

### `apply_patch`

Bir veya daha fazla dosya üzerinde yapılandırılmış yamalar uygular. Çoklu parça (multi‑hunk) düzenlemeleri için kullanın.
Deneysel: `tools.exec.applyPatch.enabled` üzerinden etkinleştirin (yalnızca OpenAI modelleri).

### `exec`

Çalışma alanında shell komutları çalıştırır.

Çekirdek parametreler:

- `command` (gerekli)
- `yieldMs` (zaman aşımından sonra otomatik arka plan, varsayılan 10000)
- `background` (hemen arka plan)
- `timeout` (saniye; aşılırsa süreci öldürür, varsayılan 1800)
- `elevated` (bool; yükseltilmiş mod etkin/izinliyse ana makinede çalıştır; yalnızca ajan sandbox içindeyken davranışı değiştirir)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (`host=node` için düğüm kimliği/adı)
- Gerçek bir TTY mi gerekiyor? `pty: true` ayarlayın.

Notlar:

- Arka planda çalıştırıldığında `sessionId` içeren `status: "running"` döndürür.
- Arka plan oturumlarını yoklamak/günlüğe almak/yazmak/öldürmek/temizlemek için `process` kullanın.
- `process` izinli değilse, `exec` eşzamanlı çalışır ve `yieldMs`/`background`’u yok sayar.
- `elevated`, `tools.elevated` ve herhangi bir `agents.list[].tools.elevated` geçersiz kılmasına bağlıdır (ikisi de izin vermelidir) ve `host=gateway` + `security=full` için bir takma addır.
- `elevated` yalnızca ajan sandbox içindeyken davranışı değiştirir (aksi halde etkisizdir).
- `host=node`, bir macOS yardımcı uygulamasını veya başsız bir düğüm ana makinesini (`openclaw node run`) hedefleyebilir.
- gateway/düğüm onayları ve izin listeleri: [Exec approvals](/tools/exec-approvals).

### `process`

Arka plan exec oturumlarını yönetir.

Çekirdek eylemler:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Notlar:

- `poll`, tamamlandığında yeni çıktı ve çıkış durumunu döndürür.
- `log`, satır bazlı `offset`/`limit`’u destekler (`offset`’i atlayarak son N satırı alın).
- 29. `process` ajan başına kapsamlıdır; diğer ajanlardan gelen oturumlar görünmez.

### `web_search`

Brave Search API kullanarak web’de arama yapar.

Çekirdek parametreler:

- `query` (gerekli)
- `count` (1–10; varsayılan `tools.web.search.maxResults`’dan)

Notlar:

- Brave API anahtarı gerektirir (önerilen: `openclaw configure --section web` veya `BRAVE_API_KEY` ayarlayın).
- `tools.web.search.enabled` üzerinden etkinleştirin.
- Yanıtlar önbelleğe alınır (varsayılan 15 dk).
- Kurulum için [Web tools](/tools/web) bölümüne bakın.

### `web_fetch`

Bir URL’den okunabilir içeriği getirir ve çıkarır (HTML → markdown/metin).

Çekirdek parametreler:

- `url` (gerekli)
- `extractMode` (`markdown` | `text`)
- `maxChars` (uzun sayfaları kısalt)

Notlar:

- `tools.web.fetch.enabled` üzerinden etkinleştirin.
- `maxChars`, `tools.web.fetch.maxCharsCap` ile sınırlandırılır (varsayılan 50000).
- Yanıtlar önbelleğe alınır (varsayılan 15 dk).
- JS ağırlıklı siteler için tarayıcı aracını tercih edin.
- Kurulum için [Web tools](/tools/web) bölümüne bakın.
- İsteğe bağlı anti‑bot yedeği için [Firecrawl](/tools/firecrawl) bölümüne bakın.

### `browser`

OpenClaw tarafından yönetilen özel tarayıcıyı kontrol eder.

Çekirdek eylemler:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (görüntü bloğu + `MEDIA:<path>` döndürür)
- `act` (UI eylemleri: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Profil yönetimi:

- `profiles` — durumla birlikte tüm tarayıcı profillerini listeler
- `create-profile` — otomatik port tahsisiyle yeni profil oluşturur (veya `cdpUrl`)
- `delete-profile` — tarayıcıyı durdurur, kullanıcı verisini siler, yapılandırmadan kaldırır (yalnızca yerel)
- `reset-profile` — profilin portundaki yetim süreci öldürür (yalnızca yerel)

Yaygın parametreler:

- `profile` (isteğe bağlı; varsayılan `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (isteğe bağlı; belirli bir düğüm kimliği/adı seçer)
  Notlar:
- `browser.enabled=true` gerektirir (varsayılan `true`; devre dışı bırakmak için `false` ayarlayın).
- Tüm eylemler, çoklu örnek desteği için isteğe bağlı `profile` parametresini kabul eder.
- `profile` atlanırsa, `browser.defaultProfile` kullanılır (varsayılan "chrome").
- Profil adları: yalnızca küçük harf alfanümerik + tire (en fazla 64 karakter).
- Port aralığı: 18800-18899 (yaklaşık 100 profil maks.).
- Uzak profiller yalnızca bağlanabilir (başlat/durdur/sıfırla yok).
- Tarayıcı yetenekli bir düğüm bağlıysa, araç otomatik yönlendirebilir ( `target` ile sabitlemezseniz).
- Playwright yüklüyken `snapshot` varsayılan olarak `ai`’dır; erişilebilirlik ağacı için `aria` kullanın.
- `snapshot`, rol‑anlık görüntü seçeneklerini (`interactive`, `compact`, `depth`, `selector`) de destekler ve `e12` gibi referanslar döndürür.
- `act`, `snapshot`’dan `ref` gerektirir (AI anlık görüntülerinden sayısal `12` veya rol anlık görüntülerinden `e12`); nadir CSS seçici ihtiyaçları için `evaluate` kullanın.
- Varsayılan olarak `act` → `wait`’dan kaçının; yalnızca istisnai durumlarda kullanın (beklenecek güvenilir bir UI durumu yoksa).
- `upload`, hazırlanma sonrası otomatik tıklama için isteğe bağlı bir `ref` geçebilir.
- `upload`, `<input type="file">`’yi doğrudan ayarlamak için `inputRef` (aria ref) veya `element` (CSS seçici) de destekler.

### `canvas`

Düğüm Canvas’ını sürer (present, eval, snapshot, A2UI).

Çekirdek eylemler:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (görüntü bloğu + `MEDIA:<path>` döndürür)
- `a2ui_push`, `a2ui_reset`

Notlar:

- Altta gateway `node.invoke` kullanır.
- `node` sağlanmazsa, araç bir varsayılan seçer (tek bağlı düğüm veya yerel mac düğümü).
- A2UI yalnızca v0.8’dir (`createSurface` yok); CLI, satır hatalarıyla v0.9 JSONL’yi reddeder.
- Hızlı kontrol: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Eşleştirilmiş düğümleri keşfeder ve hedefler; bildirim gönderir; kamera/ekran yakalar.

Çekirdek eylemler:

- `status`, `describe`
- `pending`, `approve`, `reject` (eşleştirme)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Notlar:

- Kamera/ekran komutları, düğüm uygulamasının ön planda olmasını gerektirir.
- Görseller, görüntü blokları + `MEDIA:<path>` döndürür.
- Videolar `FILE:<path>` (mp4) döndürür.
- Konum, JSON yükü (lat/lon/accuracy/timestamp) döndürür.
- `run` parametreleri: `command` argv dizisi; isteğe bağlı `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Örnek (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Yapılandırılmış görüntü modeliyle bir görüntüyü analiz eder.

Çekirdek parametreler:

- `image` (gerekli yol veya URL)
- `prompt` (isteğe bağlı; varsayılan "Görüntüyü tanımla.")
- `model` (isteğe bağlı geçersiz kılma)
- `maxBytesMb` (isteğe bağlı boyut üst sınırı)

Notlar:

- Yalnızca `agents.defaults.imageModel` yapılandırıldığında (birincil veya yedekler) ya da varsayılan modeliniz + yapılandırılmış kimlik doğrulama üzerinden örtük bir görüntü modeli çıkarılabildiğinde kullanılabilir (en iyi çaba eşleştirme).
- Görüntü modelini doğrudan kullanır (ana sohbet modelinden bağımsız).

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams genelinde mesajlar ve kanal eylemleri gönderir.

Çekirdek eylemler:

- `send` (metin + isteğe bağlı medya; MS Teams ayrıca Adaptive Cards için `card`’ü destekler)
- `poll` (WhatsApp/Discord/MS Teams anketleri)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

Notlar:

- `send`, WhatsApp’ı Gateway üzerinden yönlendirir; diğer kanallar doğrudan gider.
- `poll`, WhatsApp ve MS Teams için Gateway’i kullanır; Discord anketleri doğrudan gider.
- Bir mesaj aracı çağrısı etkin bir sohbet oturumuna bağlıyken, gönderimler bağlam sızıntılarını önlemek için o oturumun hedefiyle sınırlandırılır.

### `cron`

Gateway cron işlerini ve uyandırmaları yönetir.

Çekirdek eylemler:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (sistem olayı kuyruğa al + isteğe bağlı anında heartbeat)

Notlar:

- `add`, tam bir cron işi nesnesi bekler (`cron.add` RPC ile aynı şema).
- `update`, `{ jobId, patch }` kullanır (uyumluluk için `id` kabul edilir).

### `gateway`

Çalışan Gateway sürecini yeniden başlatır veya güncellemeleri uygular (yerinde).

Çekirdek eylemler:

- `restart` (yetkilendirir + işlem içi yeniden başlatma için `SIGUSR1` gönderir; yerinde `openclaw gateway` yeniden başlatma)
- `config.get` / `config.schema`
- `config.apply` (doğrula + yapılandırmayı yaz + yeniden başlat + uyandır)
- `config.patch` (kısmi güncellemeyi birleştir + yeniden başlat + uyandır)
- `update.run` (güncellemeyi çalıştır + yeniden başlat + uyandır)

Notlar:

- Devam eden bir yanıtı bölmemek için `delayMs` (varsayılan 2000) kullanın.
- `restart` varsayılan olarak devre dışıdır; `commands.restart: true` ile etkinleştirin.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Oturumları listeler, transkript geçmişini inceler veya başka bir oturuma gönderir.

Çekirdek parametreler:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = yok)
- `sessions_history`: `sessionKey` (veya `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (veya `sessionId`), `message`, `timeoutSeconds?` (0 = fire‑and‑forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (varsayılan geçerli; `sessionId` kabul edilir), `model?` (`default` geçersiz kılmayı temizler)

Notlar:

- `main` kanonik doğrudan sohbet anahtarıdır; küresel/bilinmeyenler gizlidir.
- `messageLimit > 0`, oturum başına son N mesajı getirir (araç mesajları filtrelenir).
- `sessions_send`, `timeoutSeconds > 0` olduğunda nihai tamamlanmayı bekler.
- Teslim/duyuru tamamlanmadan sonra gerçekleşir ve en iyi çabadır; `status: "ok"`, duyurunun teslim edildiğini değil, ajan çalışmasının bittiğini doğrular.
- `sessions_spawn`, bir alt ajan çalışması başlatır ve talep eden sohbete bir duyuru yanıtı gönderir.
- `sessions_spawn` bloklamaz ve `status: "accepted"`’yi hemen döndürür.
- `sessions_send`, yanıt‑geri ping‑pong’u çalıştırır (durdurmak için `REPLY_SKIP` yanıtlayın; maksimum tur `session.agentToAgent.maxPingPongTurns` ile, 0–5).
- Ping‑pong sonrası hedef ajan bir **duyuru adımı** çalıştırır; duyuruyu bastırmak için `ANNOUNCE_SKIP` yanıtlayın.

### `agents_list`

Geçerli oturumun `sessions_spawn` ile hedefleyebileceği ajan kimliklerini listeler.

Notlar:

- Sonuç, ajan başına izin listeleriyle (`agents.list[].subagents.allowAgents`) sınırlıdır.
- `["*"]` yapılandırıldığında, araç tüm yapılandırılmış ajanları içerir ve `allowAny: true`’i işaretler.

## Parametreler (genel)

Gateway destekli araçlar (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (varsayılan `ws://127.0.0.1:18789`)
- `gatewayToken` (kimlik doğrulama etkinse)
- `timeoutMs`

Not: `gatewayUrl` ayarlandığında, `gatewayToken`’ı açıkça ekleyin. Araçlar, geçersiz kılmalar için
yapılandırma veya ortam kimlik bilgilerini devralmaz; açık kimlik bilgisi eksikliği hatadır.

Tarayıcı aracı:

- `profile` (isteğe bağlı; varsayılan `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (isteğe bağlı; belirli bir düğüm kimliği/adını sabitle)

## Önerilen ajan akışları

Tarayıcı otomasyonu:

1. `browser` → `status` / `start`
2. `snapshot` (ai veya aria)
3. `act` (click/type/press)
4. Görsel doğrulama gerekiyorsa `screenshot`

Canvas render:

1. `canvas` → `present`
2. `a2ui_push` (isteğe bağlı)
3. `snapshot`

Düğüm hedefleme:

1. `nodes` → `status`
2. Seçilen düğümde `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## Güvenli kullanım

- Doğrudan `system.run`’ten kaçının; yalnızca açık kullanıcı onayıyla `nodes` → `run` kullanın.
- Kamera/ekran yakalama için kullanıcı onayına uyun.
- Medya komutlarını çağırmadan önce izinleri sağlamak için `status/describe` kullanın.

## 30. Araçların ajana nasıl sunulduğu

Araçlar iki paralel kanalda sunulur:

1. **Sistem istemi metni**: insan tarafından okunabilir bir liste + rehberlik.
2. **Araç şeması**: model API’sine gönderilen yapılandırılmış işlev tanımları.

Bu, ajanın hem “hangi araçlar var”ı hem de “nasıl çağrılacaklarını” görmesi anlamına gelir. Bir araç sistem isteminde veya şemada görünmüyorsa, model onu çağıramaz.
