---
summary: "Slash komutları: metin ve yerel, yapılandırma ve desteklenen komutlar"
read_when:
  - Sohbet komutlarını kullanırken veya yapılandırırken
  - Komut yönlendirmesi ya da izinleri hata ayıklarken
title: "Slash Komutları"
---

# Slash komutları

Komutlar Gateway tarafından işlenir. Çoğu komut, `/` ile başlayan **bağımsız** bir mesaj olarak gönderilmelidir.
Yalnızca ana makineye özel bash sohbet komutu `! <cmd>` kullanır (`/bash <cmd>` bir takma addır).

İki ilişkili sistem vardır:

- **Komutlar**: bağımsız `/...` mesajları.
- **Yönergeler**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Yönergeler, model mesajı görmeden önce mesajdan çıkarılır.
  - Normal sohbet mesajlarında (yalnızca yönerge olmayan), “satır içi ipuçları” olarak ele alınır ve oturum ayarlarını **kalıcı** kılmaz.
  - Yalnızca yönerge içeren mesajlarda (mesaj yalnızca yönergelerden oluşur), oturuma kalıcı olur ve bir onay yanıtı verir.
  - Yönergeler yalnızca **yetkili gönderenler** için uygulanır (kanal izin listeleri/eşleştirme artı `commands.useAccessGroups`).
    Yetkisiz gönderenler yönergeleri düz metin olarak görür.

Ayrıca birkaç **satır içi kısayol** vardır (yalnızca izin listesinde/yetkili gönderenler): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
Anında çalışırlar, model mesajı görmeden önce çıkarılırlar ve kalan metin normal akıştan devam eder.

## Yapılandırma

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (varsayılan `true`) sohbet mesajlarında `/...` ayrıştırmasını etkinleştirir.
  - Yerel komutları olmayan yüzeylerde (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), bunu `false` olarak ayarlasanız bile metin komutları çalışır.
- `commands.native` (varsayılan `"auto"`) yerel komutları kaydeder.
  - Otomatik: Discord/Telegram için açık; Slack için kapalıdır (slash komutları ekleyene kadar); yerel destek olmayan sağlayıcılarda yok sayılır.
  - Sağlayıcı bazında geçersiz kılmak için `channels.discord.commands.native`, `channels.telegram.commands.native` veya `channels.slack.commands.native` ayarlayın (bool ya da `"auto"`).
  - `false` Discord/Telegram’da daha önce kaydedilmiş komutları başlangıçta temizler. Slack komutları Slack uygulamasında yönetilir ve otomatik olarak kaldırılmaz.
- `commands.nativeSkills` (varsayılan `"auto"`) desteklendiğinde **skill** komutlarını yerel olarak kaydeder.
  - Otomatik: Discord/Telegram için açık; Slack için kapalıdır (Slack, her skill için ayrı bir slash komutu oluşturmayı gerektirir).
  - Sağlayıcı bazında geçersiz kılmak için `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` veya `channels.slack.commands.nativeSkills` ayarlayın (bool ya da `"auto"`).
- `commands.bash` (varsayılan `false`) `! <cmd>`’ın ana makinede kabuk komutları çalıştırmasını etkinleştirir (`/bash <cmd>` bir takma addır; `tools.elevated` izin listeleri gerektirir).
- `commands.bashForegroundMs` (varsayılan `2000`) bash’in arka plan moduna geçmeden önce ne kadar bekleyeceğini kontrol eder (`0` anında arka plana alır).
- `commands.config` (varsayılan `false`) `/config`’i etkinleştirir (`openclaw.json` okur/yazar).
- `commands.debug` (varsayılan `false`) `/debug`’yi etkinleştirir (yalnızca çalışma zamanı geçersiz kılmaları).
- `commands.useAccessGroups` (varsayılan `true`) komutlar için izin listeleri/politikaları zorunlu kılar.

## Komut listesi

Metin + yerel (etkinleştirildiğinde):

- `/help`
- `/commands`
- `/skill <name> [input]` (adıyla bir skill çalıştırır)
- `/status` (mevcut durumu gösterir; mevcut model sağlayıcısı için sağlayıcı kullanımı/kota bilgilerini, mevcutsa, içerir)
- `/allowlist` (izin listesi girdilerini listele/ekle/kaldır)
- `/approve <id> allow-once|allow-always|deny` (çalıştırma onayı istemlerini çözer)
- `/context [list|detail|json]` (“context”i açıklar; `detail` dosya başına + araç başına + skill başına + sistem istemi boyutunu gösterir)
- `/whoami` (gönderen kimliğinizi gösterir; takma ad: `/id`)
- `/subagents list|stop|log|info|send` (mevcut oturum için alt ajan çalıştırmalarını incele, durdur, günlüğünü al veya mesaj gönder)
- `/config show|get|set|unset` (yapılandırmayı diske kalıcı yazar, yalnızca sahip; `commands.config: true` gerektirir)
- `/debug show|set|unset|reset` (çalışma zamanı geçersiz kılmaları, yalnızca sahip; `commands.debug: true` gerektirir)
- `/usage off|tokens|full|cost` (yanıt başına kullanım altbilgisi veya yerel maliyet özeti)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (TTS’yi kontrol eder; bkz. [/tts](/tts))
  - Discord: yerel komut `/voice`’dir (Discord `/tts`’ü ayırır); metin `/tts` hâlâ çalışır.
- `/stop`
- `/restart`
- `/dock-telegram` (takma ad: `/dock_telegram`) (yanıtları Telegram’a yönlendirir)
- `/dock-discord` (takma ad: `/dock_discord`) (yanıtları Discord’a yönlendirir)
- `/dock-slack` (takma ad: `/dock_slack`) (yanıtları Slack’e yönlendirir)
- `/activation mention|always` (yalnızca gruplar)
- `/send on|off|inherit` (yalnızca sahip)
- `/reset` veya `/new [model]` (isteğe bağlı model ipucu; kalan metin aynen iletilir)
- `/think <off|minimal|low|medium|high|xhigh>` (modele/sağlayıcıya göre dinamik seçenekler; takma adlar: `/thinking`, `/t`)
- `/verbose on|full|off` (takma ad: `/v`)
- `/reasoning on|off|stream` (takma ad: `/reason`; açıkken `Reasoning:` önekiyle ayrı bir mesaj gönderir; `stream` = yalnızca Telegram taslağı)
- `/elevated on|off|ask|full` (takma ad: `/elev`; `full` çalıştırma onaylarını atlar)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (mevcudu göstermek için `/exec` gönderin)
- `/model <name>` (takma ad: `/models`; veya `agents.defaults.models.*.alias`’ten `/<alias>`)
- `/queue <mode>` (`debounce:2s cap:25 drop:summarize` gibi seçeneklerle; mevcut ayarları görmek için `/queue` gönderin)
- `/bash <command>` (yalnızca ana makine; `! <command>` için takma ad; `commands.bash: true` + `tools.elevated` izin listeleri gerektirir)

Yalnızca metin:

- `/compact [instructions]` (bkz. [/concepts/compaction](/concepts/compaction))
- `! <command>` (yalnızca ana makine; aynı anda bir tane; uzun süren işler için `!poll` + `!stop` kullanın)
- `!poll` (çıktıyı/durumu kontrol eder; isteğe bağlı `sessionId` kabul eder; `/bash poll` da çalışır)
- `!stop` (çalışan bash işini durdurur; isteğe bağlı `sessionId` kabul eder; `/bash stop` da çalışır)

Notlar:

- Komutlar, komut ile argümanlar arasında isteğe bağlı bir `:` kabul eder (ör. `/think: high`, `/send: on`, `/help:`).
- `/new <model>` bir model takma adını, `provider/model`’yi veya bir sağlayıcı adını (yaklaşık eşleşme) kabul eder; eşleşme yoksa metin mesaj gövdesi olarak ele alınır.
- Sağlayıcı kullanımının tam dökümü için `openclaw status --usage` kullanın.
- `/allowlist add|remove` `commands.config=true` gerektirir ve kanal `configWrites`’lerine uyar.
- `/usage` yanıt başına kullanım altbilgisini kontrol eder; `/usage cost` OpenClaw oturum günlüklerinden yerel bir maliyet özeti yazdırır.
- `/restart` varsayılan olarak devre dışıdır; etkinleştirmek için `commands.restart: true` ayarlayın.
- `/verbose` hata ayıklama ve ek görünürlük içindir; normal kullanımda **kapalı** tutun.
- `/reasoning` (ve `/verbose`) grup ayarlarında risklidir: istemeden iç muhakeme veya araç çıktısı ifşa edebilir. Özellikle grup sohbetlerinde kapalı bırakmayı tercih edin.
- **Hızlı yol:** izin listesinde olan gönderenlerden gelen yalnızca komut mesajları anında işlenir (kuyruk + model atlanır).
- **Grup bahsetme geçidi:** izin listesinde olan gönderenlerden gelen yalnızca komut mesajları bahsetme gereksinimlerini atlar.
- **Satır içi kısayollar (yalnızca izin listesinde olan gönderenler):** belirli komutlar normal bir mesajın içine gömülü olarak da çalışır ve model kalan metni görmeden önce çıkarılır.
  - Örnek: `hey /status` bir durum yanıtını tetikler ve kalan metin normal akıştan devam eder.
- Şu anda: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Yetkisiz yalnızca komut mesajları sessizce yok sayılır ve satır içi `/...` belirteçleri düz metin olarak ele alınır.
- **Skill komutları:** `user-invocable` skill’leri slash komutları olarak sunulur. Adlar `a-z0-9_`’ye göre temizlenir (en fazla 32 karakter); çakışmalara sayısal sonekler eklenir (ör. `_2`).
  - `/skill <name> [input]` adıyla bir skill çalıştırır (yerel komut sınırları, skill başına komutları engellediğinde kullanışlıdır).
  - Varsayılan olarak skill komutları modele normal bir istek olarak iletilir.
  - Skill’ler isteğe bağlı olarak `command-dispatch: tool` bildirebilir; bu durumda komut doğrudan bir araca yönlendirilir (deterministik, modelsiz).
  - Örnek: `/prose` (OpenProse eklentisi) — bkz. [OpenProse](/prose).
- **Yerel komut argümanları:** Discord dinamik seçenekler için otomatik tamamlama kullanır (gerekli argümanları atladığınızda düğme menüleri). Telegram ve Slack, bir komut seçenekleri desteklediğinde ve argümanı atladığınızda bir düğme menüsü gösterir.

## Kullanım yüzeyleri (nerede ne görünür)

- **Sağlayıcı kullanımı/kota** (örnek: “Claude %80 kaldı”) kullanım takibi etkinleştirildiğinde, mevcut model sağlayıcısı için `/status`’te görünür.
- **Yanıt başına belirteçler/maliyet** `/usage off|tokens|full` ile kontrol edilir (normal yanıtlara eklenir).
- `/model status` **modeller/kimlik doğrulama/uç noktalar** hakkındadır; kullanım hakkında değildir.

## Model seçimi (`/model`)

`/model` bir yönerge olarak uygulanır.

Örnekler:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Notlar:

- `/model` ve `/model list` kompakt, numaralı bir seçici gösterir (model ailesi + mevcut sağlayıcılar).
- `/model <#>` bu seçiciden seçim yapar (mümkünse mevcut sağlayıcıyı tercih eder).
- `/model status` ayrıntılı görünümü gösterir; yapılandırılmış sağlayıcı uç noktasını (`baseUrl`) ve mevcutsa API modunu (`api`) içerir.

## 49. Hata ayıklama geçersiz kılmaları

`/debug` **yalnızca çalışma zamanı** yapılandırma geçersiz kılmalarını ayarlamanıza izin verir (bellek, diske yazılmaz). Yalnızca sahip. Varsayılan olarak devre dışıdır; `commands.debug: true` ile etkinleştirin.

Örnekler:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notlar:

- Geçersiz kılmalar yeni yapılandırma okumalarına anında uygulanır, ancak `openclaw.json`’e **yazılmaz**.
- Tüm geçersiz kılmaları temizlemek ve disk üzerindeki yapılandırmaya dönmek için `/debug reset` kullanın.

## Yapılandırma güncellemeleri

`/config` disk üzerindeki yapılandırmanıza (`openclaw.json`) yazar. Yalnızca sahip. Varsayılan olarak devre dışıdır; `commands.config: true` ile etkinleştirin.

Örnekler:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Notlar:

- Yazmadan önce yapılandırma doğrulanır; geçersiz değişiklikler reddedilir.
- `/config` güncellemeleri yeniden başlatmalar arasında kalıcıdır.

## Yüzey notları

- **Metin komutları** normal sohbet oturumunda çalışır (DM’ler `main` paylaşır, grupların kendi oturumu vardır).
- **Yerel komutlar** yalıtılmış oturumlar kullanır:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (öneki `channels.slack.slashCommand.sessionPrefix` ile yapılandırılabilir)
  - Telegram: `telegram:slash:<userId>` (`CommandTargetSessionKey` aracılığıyla sohbet oturumunu hedefler)
- **`/stop`** etkin sohbet oturumunu hedefler, böylece mevcut çalıştırmayı iptal edebilir.
- **Slack:** `channels.slack.slashCommand` tek bir `/openclaw` tarzı komut için hâlâ desteklenir. `commands.native`’ı etkinleştirirseniz, yerleşik her komut için bir Slack slash komutu oluşturmanız gerekir (`/help` ile aynı adlar). Slack için komut argüman menüleri, geçici Block Kit düğmeleri olarak sunulur.
