---
summary: "Heartbeat yoklama mesajları ve bildirim kuralları"
read_when:
  - Heartbeat sıklığını veya mesajlaşmayı ayarlarken
  - Zamanlanmış görevler için heartbeat ile cron arasında karar verirken
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat mi Cron mu?** Hangisinin ne zaman kullanılacağına dair rehber için [Cron vs Heartbeat](/automation/cron-vs-heartbeat) bölümüne bakın.

Heartbeat, ana oturumda **periyodik ajan dönüşleri** çalıştırır; böylece model,
sizi gereksiz yere mesaj bombardımanına tutmadan dikkat gerektiren konuları
gündeme getirebilir.

Sorun giderme: [/automation/troubleshooting](/automation/troubleshooting)

## Hızlı başlangıç (yeni başlayanlar)

1. Heartbeat’leri etkin bırakın (varsayılan `30m`; Anthropic OAuth/setup-token için `1h`) veya kendi sıklığınızı ayarlayın.
2. Ajan çalışma alanında küçük bir `HEARTBEAT.md` kontrol listesi oluşturun (isteğe bağlı ama önerilir).
3. Heartbeat mesajlarının nereye gideceğine karar verin (varsayılan `target: "last"`).
4. İsteğe bağlı: şeffaflık için heartbeat muhakeme iletimini etkinleştirin.
5. İsteğe bağlı: heartbeat’leri yalnızca aktif saatlerle sınırlayın (yerel saat).

Örnek yapılandırma:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Varsayılanlar

- Aralık: `30m` (Anthropic OAuth/setup-token algılanan kimlik doğrulama modu olduğunda `1h`). Küresel olarak `agents.defaults.heartbeat.every` veya ajan bazında `agents.list[].heartbeat.every` ayarlayın; devre dışı bırakmak için `0m` kullanın.
- İstem gövdesi (`agents.defaults.heartbeat.prompt` ile yapılandırılabilir):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Heartbeat istemi kullanıcı mesajı olarak **aynen** gönderilir. Sistem istemi bir “Heartbeat” bölümü içerir ve çalıştırma dahili olarak işaretlenir.
- Aktif saatler (`heartbeat.activeHours`) yapılandırılan saat diliminde kontrol edilir.
  Pencere dışında heartbeat’ler, pencere içindeki bir sonraki tetiklemeye kadar atlanır.

## Heartbeat isteminin amacı

Varsayılan istem kasıtlı olarak geniştir:

- **Arka plan görevleri**: “Consider outstanding tasks” ifadesi, ajanın
  takipleri (gelen kutusu, takvim, hatırlatıcılar, kuyruktaki işler) gözden
  geçirmesini ve acil olanları öne çıkarmasını teşvik eder.
- **İnsanla kısa yoklama**: “Checkup sometimes on your human during day time”
  ifadesi, ara sıra hafif bir “Bir şeye ihtiyacın var mı?” mesajını teşvik eder;
  ancak yapılandırılmış yerel saat dilimini kullanarak gece spam’ini önler
  (bkz. [/concepts/timezone](/concepts/timezone)).

Heartbeat’in çok spesifik bir şey yapmasını istiyorsanız (ör. “check Gmail PubSub
stats” veya “verify gateway health”), `agents.defaults.heartbeat.prompt` (veya
`agents.list[].heartbeat.prompt`) ile özel bir gövde ayarlayın (aynen gönderilir).

## Yanıt sözleşmesi

- Dikkat gerektiren bir şey yoksa **`HEARTBEAT_OK`** ile yanıtlayın.
- Heartbeat çalıştırmaları sırasında OpenClaw, **yanıtın başında veya sonunda**
  göründüğünde `HEARTBEAT_OK`’ü bir onay (ack) olarak kabul eder. Belirteç
  çıkarılır ve kalan içerik **≤ `ackMaxChars`** (varsayılan: 300) ise yanıt
  düşürülür.
- `HEARTBEAT_OK` yanıtın **ortasında** görünürse özel olarak ele alınmaz.
- Uyarılar için **`HEARTBEAT_OK` eklemeyin**; yalnızca uyarı metnini döndürün.

Heartbeat dışında, mesajın başında/sonunda bulunan başıboş `HEARTBEAT_OK` çıkarılır
ve kaydedilir; yalnızca `HEARTBEAT_OK` olan bir mesaj düşürülür.

## Yapılandırma

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Kapsam ve öncelik

- `agents.defaults.heartbeat` küresel heartbeat davranışını ayarlar.
- `agents.list[].heartbeat` bunun üzerine birleştirilir; herhangi bir ajanda
  `heartbeat` bloğu varsa **yalnızca o ajanlar** heartbeat çalıştırır.
- `channels.defaults.heartbeat` tüm kanallar için görünürlük varsayılanlarını ayarlar.
- `channels.<channel>.heartbeat` kanal varsayılanlarını geçersiz kılar.
- `channels.<channel>.accounts.<id>.heartbeat` (çoklu hesap kanalları) kanal başına ayarları geçersiz kılar.

### Per-agent heartbeats

Herhangi bir `agents.list[]` girdisi bir `heartbeat` bloğu içeriyorsa,
**yalnızca o ajanlar** heartbeat çalıştırır. Ajan başına blok,
`agents.defaults.heartbeat`’in üzerine birleştirilir (paylaşılan varsayılanları bir kez
ayarlayıp ajan bazında geçersiz kılabilirsiniz).

Örnek: iki ajan, yalnızca ikinci ajan heartbeat çalıştırır.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Aktif saatler örneği

Belirli bir saat diliminde heartbeat’leri mesai saatleriyle sınırlayın:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Bu pencerenin dışında (Doğu saatiyle 09:00’dan önce veya 22:00’den sonra)
heartbeat’ler atlanır. Pencere içindeki bir sonraki planlı tetikleme normal şekilde çalışır.

### Çoklu hesap örneği

Telegram gibi çoklu hesaplı kanallarda belirli bir hesabı hedeflemek için
`accountId` kullanın:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Alan notları

- `every`: heartbeat aralığı (süre dizesi; varsayılan birim = dakika).
- `model`: heartbeat çalıştırmaları için isteğe bağlı model geçersiz kılma (`provider/model`).
- `includeReasoning`: etkinleştirildiğinde, ayrı `Reasoning:` mesajını da mevcut olduğunda iletir (şekli `/reasoning on` ile aynıdır).
- `session`: heartbeat çalıştırmaları için isteğe bağlı oturum anahtarı.
  - `main` (default): agent main session.
  - Açık oturum anahtarı (`openclaw sessions --json`’den veya [sessions CLI](/cli/sessions) üzerinden kopyalayın).
  - Oturum anahtarı biçimleri: [Sessions](/concepts/session) ve [Groups](/channels/groups) bölümlerine bakın.
- `target`:
  - `last` (varsayılan): son kullanılan harici kanala iletir.
  - açık kanal: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: heartbeat’i çalıştırır ancak harici olarak **iletmez**.
- `to`: isteğe bağlı alıcı geçersiz kılma (kanala özgü kimlik; ör. WhatsApp için E.164 veya Telegram sohbet kimliği).
- `accountId`: çoklu hesap kanalları için isteğe bağlı hesap kimliği. `target: "last"` olduğunda, hesap kimliği destekliyorsa çözümlenen son kanala uygulanır; aksi halde yok sayılır. Hesap kimliği, çözümlenen kanal için yapılandırılmış bir hesapla eşleşmezse iletim atlanır.
- `prompt`: varsayılan istem gövdesini geçersiz kılar (birleştirilmez).
- `ackMaxChars`: iletimden önce `HEARTBEAT_OK` sonrasında izin verilen azami karakter sayısı.
- `activeHours`: heartbeat çalıştırmalarını bir zaman penceresiyle sınırlar. `start` (HH:MM, dahil), `end` (HH:MM, hariç; gün sonu için `24:00` kabul edilir) ve isteğe bağlı `timezone` içeren nesne.
  - Atlanırsa veya `"user"` ise: ayarlıysa `agents.defaults.userTimezone` kullanılır, aksi halde ana makine sistem saat dilimine geri düşer.
  - `"local"`: her zaman ana makine sistem saat dilimini kullanır.
  - Herhangi bir IANA tanımlayıcısı (ör. `America/New_York`): doğrudan kullanılır; geçersizse yukarıdaki `"user"` davranışına geri düşer.
  - Aktif pencere dışında heartbeat’ler, pencere içindeki bir sonraki tetiklemeye kadar atlanır.

## İletim davranışı

- Heartbeat’ler varsayılan olarak ajanın ana oturumunda çalışır (`agent:<id>:<mainKey>`),
  veya `session.scope = "global"` olduğunda `global`. Belirli bir kanal oturumuna
  (Discord/WhatsApp vb.) geçersiz kılmak için `session` ayarlayın.
- `session` yalnızca çalıştırma bağlamını etkiler; iletim `target` ve `to` tarafından kontrol edilir.
- Belirli bir kanal/alıcıya iletmek için `target` + `to` ayarlayın. `target: "last"` ile, iletim o oturum için son harici kanalı kullanır.
- Ana kuyruk meşgulse heartbeat atlanır ve daha sonra yeniden denenir.
- `target` harici bir hedefe çözümlenmezse, çalıştırma yine gerçekleşir ancak giden mesaj gönderilmez.
- Yalnızca heartbeat yanıtları oturumu canlı tutmaz; son `updatedAt` geri yüklenir, böylece boşta kalma süresi normal davranır.

## Görünürlük denetimleri

Varsayılan olarak, `HEARTBEAT_OK` onayları bastırılırken uyarı içeriği iletilir. Bunu kanal veya hesap bazında ayarlayabilirsiniz:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Öncelik: hesap başına → kanal başına → kanal varsayılanları → yerleşik varsayılanlar.

### Her bayrağın yaptığı

- `showOk`: model yalnızca OK içeren bir yanıt döndürdüğünde bir `HEARTBEAT_OK` onayı gönderir.
- `showAlerts`: model OK olmayan bir yanıt döndürdüğünde uyarı içeriğini gönderir.
- `useIndicator`: UI durum yüzeyleri için gösterge olayları üretir.

**Üçü de** false ise, OpenClaw heartbeat çalıştırmasını tamamen atlar (model çağrısı yok).

### Kanal başına vs hesap başına örnekler

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Yaygın kalıplar

| Amaç                                                                  | Yapılandırma                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Varsayılan davranış (sessiz OK’ler, uyarılar açık) | _(yapılandırma gerekmez)_                                             |
| Tamamen sessiz (mesaj yok, gösterge yok)           | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Yalnızca gösterge (mesaj yok)                      | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OK’ler yalnızca tek bir kanalda                                       | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (isteğe bağlı)

Çalışma alanında bir `HEARTBEAT.md` dosyası varsa, varsayılan istem ajana onu
okumasını söyler. Bunu “heartbeat kontrol listeniz” gibi düşünün: küçük, stabil
ve her 30 dakikada bir dahil edilmesi güvenli.

`HEARTBEAT.md` varsa ancak fiilen boşsa (yalnızca boş satırlar ve
`# Heading` gibi markdown başlıkları içeriyorsa), OpenClaw API çağrılarını
kurtarmak için heartbeat çalıştırmasını atlar.
Dosya yoksa heartbeat yine çalışır
ve model ne yapacağına karar verir.

İstem şişmesini önlemek için küçük tutun (kısa kontrol listesi veya hatırlatmalar).

Örnek `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Ajan HEARTBEAT.md dosyasını güncelleyebilir mi?

Evet — isterseniz.

`HEARTBEAT.md` ajan çalışma alanında sıradan bir dosyadır; bu nedenle ajana
(normal bir sohbette) şuna benzer şeyler söyleyebilirsiniz:

- “`HEARTBEAT.md` dosyasını günlük takvim kontrolü ekleyecek şekilde güncelle.”
- “`HEARTBEAT.md` dosyasını daha kısa ve gelen kutusu takiplerine odaklı olacak şekilde yeniden yaz.”

Bunun proaktif olmasını istiyorsanız, heartbeat isteminize şu gibi açık bir satır da ekleyebilirsiniz: “Kontrol listesi bayatlamışsa, daha iyisiyle HEARTBEAT.md dosyasını güncelle.”

Güvenlik notu: `HEARTBEAT.md` içine sırlar (API anahtarları, telefon numaraları, özel belirteçler) koymayın — istem bağlamının bir parçası olur.

## Manuel uyandırma (istek üzerine)

Bir sistem olayı kuyruğa alarak anında bir heartbeat tetikleyebilirsiniz:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Birden fazla ajan `heartbeat` yapılandırmışsa, manuel uyandırma bu ajanların
her birinin heartbeat’ini hemen çalıştırır.

Bir sonraki planlı tetiklemeyi beklemek için `--mode next-heartbeat` kullanın.

## Reasoning delivery (optional)

Varsayılan olarak, heartbeat’ler yalnızca nihai “yanıt” yükünü iletir.

Şeffaflık istiyorsanız, şunu etkinleştirin:

- `agents.defaults.heartbeat.includeReasoning: true`

Etkinleştirildiğinde, heartbeat’ler ayrıca `Reasoning:` önekiyle başlayan ayrı
bir mesaj da iletir (şekli `HEARTBEAT_OK` ile aynıdır). Bu, ajan birden fazla
oturum/codex yönetirken sizi neden dürttüğünü görmek için yararlı olabilir — ancak
isteyebileceğinizden daha fazla iç ayrıntı da sızdırabilir. Grup sohbetlerinde
kapalı tutmayı tercih edin.

## Maliyet farkındalığı

Heartbeat’ler tam ajan dönüşleri çalıştırır. Daha kısa aralıklar daha fazla token
harcar. `HEARTBEAT.md`’u küçük tutun ve yalnızca dahili durum güncellemeleri
istiyorsanız daha ucuz bir `model` veya `target: "none"` düşünün.
