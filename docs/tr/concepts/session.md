---
summary: "Sohbetler için oturum yönetimi kuralları, anahtarlar ve kalıcılık"
read_when:
  - Oturum işleme veya depolamayı değiştirirken
title: "Oturum Yönetimi"
---

# Oturum Yönetimi

OpenClaw, **her ajan için bir doğrudan sohbet oturumunu** birincil olarak ele alır. Doğrudan sohbetler `agent:<agentId>:<mainKey>`’e (varsayılan `main`) daraltılırken, grup/kanal sohbetleri kendi anahtarlarını alır. `session.mainKey` dikkate alınır.

**Doğrudan mesajların** nasıl gruplanacağını denetlemek için `session.dmScope` kullanın:

- `main` (varsayılan): süreklilik için tüm DM’ler ana oturumu paylaşır.
- `per-peer`: kanallar genelinde gönderen kimliğine göre yalıtım.
- `per-channel-peer`: kanal + gönderen bazında yalıtım (çok kullanıcılı gelen kutuları için önerilir).
- `per-account-channel-peer`: hesap + kanal + gönderen bazında yalıtım (çok hesaplı gelen kutuları için önerilir).
  `session.identityLinks`’i kullanarak sağlayıcı önekli eş kimliklerini kanonik bir kimliğe eşleyin; böylece `per-peer`, `per-channel-peer` veya `per-account-channel-peer` kullanılırken aynı kişi kanallar arasında tek bir DM oturumunu paylaşır.

## Güvenli DM modu (çok kullanıcılı kurulumlar için önerilir)

> **Güvenlik Uyarısı:** Ajanınız **birden fazla kişiden** DM alabiliyorsa, güvenli DM modunu etkinleştirmeniz şiddetle önerilir. Aksi halde tüm kullanıcılar aynı konuşma bağlamını paylaşır; bu da kullanıcılar arasında özel bilgilerin sızmasına yol açabilir.

**Varsayılan ayarlarla ortaya çıkan soruna örnek:**

- Alice (`<SENDER_A>`) ajanınıza özel bir konu hakkında mesaj atar (örneğin bir tıbbi randevu)
- Bob (`<SENDER_B>`) ajanınıza “Ne hakkında konuşuyorduk?” diye sorar
- Her iki DM aynı oturumu paylaştığı için model, Alice’in önceki bağlamını kullanarak Bob’a yanıt verebilir.

**Çözüm:** Oturumları kullanıcı başına yalıtmak için `dmScope`’yi ayarlayın:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**Ne zaman etkinleştirilir:**

- Birden fazla gönderen için eşleştirme onaylarınız varsa
- Birden çok girdisi olan bir DM izin listesi kullanıyorsanız
- `dmPolicy: "open"` ayarladıysanız
- Birden fazla telefon numarası veya hesap ajanınıza mesaj gönderebiliyorsa

Notlar:

- Varsayılan değer süreklilik için `dmScope: "main"`’dur (tüm DM’ler ana oturumu paylaşır). Bu, tek kullanıcılı kurulumlar için uygundur.
- Aynı kanalda çok hesaplı gelen kutuları için `per-account-channel-peer` tercih edin.
- Aynı kişi birden fazla kanaldan sizinle iletişime geçiyorsa, DM oturumlarını tek bir kanonik kimlikte birleştirmek için `session.identityLinks` kullanın.
- DM ayarlarınızı `openclaw security audit` ile doğrulayabilirsiniz (bkz. [security](/cli/security)).

## Gerçeğin kaynağı Gateway’dir

Tüm oturum durumu **gateway’e aittir** (“ana” OpenClaw). UI istemcileri (macOS uygulaması, WebChat vb.) yerel dosyaları okumak yerine oturum listeleri ve belirteç sayıları için gateway’i sorgulamalıdır.

- **Uzak modda**, ilgilendiğiniz oturum deposu Mac’inizde değil, uzak gateway ana makinesindedir.
- UI’larda gösterilen belirteç sayıları gateway’in depo alanlarından gelir (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). İstemciler toplamları “düzeltmek” için JSONL dökümlerini ayrıştırmaz.

## Durumun yaşadığı yerler

- **Gateway ana makinesinde**:
  - Depo dosyası: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (ajan başına).
- Dökümler: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram konu oturumları `.../<SessionId>-topic-<threadId>.jsonl` kullanır).
- Depo, `sessionKey -> { sessionId, updatedAt, ... }` haritasıdır. Girdileri silmek güvenlidir; gerektiğinde yeniden oluşturulurlar.
- Grup girdileri, UI’larda oturumları etiketlemek için `displayName`, `channel`, `subject`, `room` ve `space` içerebilir.
- Oturum girdileri, UI’ların bir oturumun nereden geldiğini açıklayabilmesi için `origin` meta verilerini (etiket + yönlendirme ipuçları) içerir.
- OpenClaw, eski Pi/Tau oturum klasörlerini **okumaz**.

## Session pruning

OpenClaw, varsayılan olarak LLM çağrılarından hemen önce bellek içi bağlamdan **eski araç sonuçlarını** kırpar.
Bu işlem JSONL geçmişini **yeniden yazmaz**. [/concepts/session-pruning](/concepts/session-pruning).

## Ön-sıkıştırma bellek boşaltma

Bir oturum otomatik sıkıştırmaya yaklaştığında, OpenClaw **sessiz bir bellek boşaltma**
dönüşü çalıştırarak modele kalıcı notları diske yazmasını hatırlatabilir. Bu yalnızca
çalışma alanı yazılabilir olduğunda çalışır. Bkz. [Memory](/concepts/memory) ve
[Compaction](/concepts/compaction).

## Taşıma → oturum anahtarları eşlemesi

- Doğrudan sohbetler `session.dmScope`’yi izler (varsayılan `main`).
  - `main`: `agent:<agentId>:<mainKey>` (cihazlar/kanallar arasında süreklilik).
    - Birden fazla telefon numarası ve kanal aynı ajan ana anahtarına eşlenebilir; tek bir konuşmaya taşıma görevi görürler.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId varsayılanı `default`’dir).
  - `session.identityLinks` sağlayıcı önekli bir eş kimlikle eşleşirse (örneğin `telegram:123`), kanonik anahtar `<peerId>`’nin yerini alır; böylece aynı kişi kanallar arasında bir oturumu paylaşır.
- Grup sohbetleri durumu yalıtır: `agent:<agentId>:<channel>:group:<id>` (odalar/kanallar `agent:<agentId>:<channel>:channel:<id>` kullanır).
  - Telegram forum konuları, yalıtım için grup kimliğine `:topic:<threadId>` ekler.
  - Eski `group:<id>` anahtarları geçiş için hâlâ tanınır.
- Gelen bağlamlar hâlâ `group:<id>` kullanabilir; kanal `Provider`’dan çıkarılır ve kanonik `agent:<agentId>:<channel>:group:<id>` biçimine normalize edilir.
- Diğer kaynaklar:
  - Cron işleri: `cron:<job.id>`
  - Webhook’lar: `hook:<uuid>` (hook tarafından açıkça ayarlanmadıkça)
  - Node çalıştırmaları: `node-<nodeId>`

## Yaşam döngüsü

- Sıfırlama politikası: oturumlar süreleri dolana kadar yeniden kullanılır ve süre dolumu bir sonraki gelen mesajda değerlendirilir.
- Günlük sıfırlama: varsayılan olarak **gateway ana makinesinin yerel saatine göre 04:00**. Son güncellemesi en son günlük sıfırlama zamanından önce olan bir oturum bayattır.
- Boşta sıfırlama (isteğe bağlı): `idleMinutes` kayan bir boşta penceresi ekler. Günlük ve boşta sıfırlamalar birlikte yapılandırıldığında, **hangisi önce dolarsa** yeni bir oturumu zorlar.
- Eski yalnızca-boşta: herhangi bir `session.reset`/`resetByType` yapılandırması olmadan `session.idleMinutes` ayarlarsanız, OpenClaw geriye dönük uyumluluk için yalnızca-boşta modunda kalır.
- Tür başına geçersiz kılmalar (isteğe bağlı): `resetByType`, `dm`, `group` ve `thread` oturumları için politikayı geçersiz kılmanıza izin verir (thread = Slack/Discord thread’leri, Telegram konuları, bağlayıcı tarafından sağlandığında Matrix thread’leri).
- Kanal başına geçersiz kılmalar (isteğe bağlı): `resetByChannel`, bir kanal için sıfırlama politikasını geçersiz kılar (o kanalın tüm oturum türlerine uygulanır ve `reset`/`resetByType`’in önüne geçer).
- Sıfırlama tetikleyicileri: tam `/new` veya `/reset` (artı `resetTriggers`’teki ekler) yeni bir oturum kimliği başlatır ve mesajın kalanını iletir. `/new <model>`, yeni oturum modelini ayarlamak için bir model takma adı, `provider/model` veya sağlayıcı adını (yaklaşık eşleşme) kabul eder. `/new` veya `/reset` tek başına gönderilirse, OpenClaw sıfırlamayı doğrulamak için kısa bir “merhaba” selamlaması çalıştırır.
- Manuel sıfırlama: depodan belirli anahtarları silin veya JSONL dökümünü kaldırın; bir sonraki mesaj bunları yeniden oluşturur.
- Yalıtılmış cron işleri her çalıştırmada her zaman yeni bir `sessionId` üretir (boşta yeniden kullanım yoktur).

## Gönderim politikası (isteğe bağlı)

Tek tek kimlikleri listelemeden belirli oturum türleri için teslimatı engelleyin.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

Runtime override (owner only):

- `/send on` → bu oturum için izin ver
- `/send off` → bu oturum için reddet
- `/send inherit` → geçersiz kılmayı temizle ve yapılandırma kurallarını kullan
  Kaydolmaları için bunları bağımsız mesajlar olarak gönderin.

## Yapılandırma (isteğe bağlı yeniden adlandırma örneği)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## İnceleme

- `openclaw status` — depo yolunu ve son oturumları gösterir.
- `openclaw sessions --json` — her girdiyi döker (`--active <minutes>` ile filtreleyin).
- `openclaw gateway call sessions.list --params '{}'` — çalışan gateway’den oturumları getirir (uzak gateway erişimi için `--url`/`--token` kullanın).
- Ajanın erişilebilir olup olmadığını, oturum bağlamının ne kadarının kullanıldığını, mevcut düşünme/ayrıntılı anahtarlarını ve WhatsApp web kimlik bilgilerinizin en son ne zaman yenilendiğini görmek için sohbette bağımsız bir mesaj olarak `/status` gönderin (yeniden bağlama gereksinimlerini tespit etmeye yardımcı olur).
- Sistem isteminde ve enjekte edilen çalışma alanı dosyalarında neler olduğunu (ve en büyük bağlam katkılarını) görmek için `/context list` veya `/context detail` gönderin.
- Geçerli çalıştırmayı iptal etmek, bu oturum için kuyruğa alınmış takipleri temizlemek ve bundan türetilmiş tüm alt ajan çalıştırmalarını durdurmak için bağımsız bir mesaj olarak `/stop` gönderin (yanıt, durdurulan sayıyı içerir).
- Eski bağlamı özetlemek ve pencere alanını boşaltmak için bağımsız bir mesaj olarak `/compact` (isteğe bağlı talimatlar) gönderin. [/concepts/compaction](/concepts/compaction).
- Tam turları gözden geçirmek için JSONL dökümleri doğrudan açılabilir.

## İpuçları

- Birincil anahtarı 1:1 trafik için ayırın; gruplar kendi anahtarlarını kullansın.
- Temizliği otomatikleştirirken, diğer yerlerdeki bağlamı korumak için tüm depo yerine tek tek anahtarları silin.

## Oturum kökeni meta verileri

Her oturum girdisi, en iyi çaba ile nereden geldiğini `origin` içinde kaydeder:

- `label`: insan tarafından okunabilir etiket (konuşma etiketi + grup konusu/kanaldan çözülür)
- `provider`: normalize edilmiş kanal kimliği (uzantılar dâhil)
- `from`/`to`: gelen zarfından ham yönlendirme kimlikleri
- `accountId`: sağlayıcı hesap kimliği (çok hesaplı olduğunda)
- `threadId`: kanal destekliyorsa thread/konu kimliği
  Köken alanları doğrudan mesajlar, kanallar ve gruplar için doldurulur. Bir
  bağlayıcı yalnızca teslim yönlendirmesini güncelliyorsa (örneğin bir DM ana oturumunu
  taze tutmak için), oturumun açıklayıcı meta verilerini koruması için yine de gelen
  bağlamı sağlamalıdır. Uzantılar bunu, gelen bağlamda `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace` ve `SenderName` göndererek ve
  `recordSessionMetaFromInbound`’yı çağırarak (veya aynı bağlamı `updateLastRoute`’ye geçirerek)
  yapabilir.
