---
summary: "gateway, kanallar, otomasyon, düğümler ve tarayıcı için derinlemesine sorun giderme runbook'u"
read_when:
  - Sorun giderme merkezi sizi daha derin teşhis için buraya yönlendirdiyse
  - Kesin komutlarla kararlı, belirtiye dayalı runbook bölümlerine ihtiyacınız varsa
title: "Sorun Giderme"
---

# Gateway sorun giderme

Bu sayfa derin runbook'tur.
Önce hızlı triyaj akışını istiyorsanız [/help/troubleshooting](/help/troubleshooting) ile başlayın.

## Komut merdiveni

Bunları önce, bu sırayla çalıştırın:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Beklenen sağlıklı sinyaller:

- `openclaw gateway status` içinde `Runtime: running` ve `RPC probe: ok` görünür.
- `openclaw doctor` engelleyici yapılandırma/hizmet sorunu olmadığını bildirir.
- `openclaw channels status --probe` bağlı/hazır kanalları gösterir.

## Yanıt yok

Kanallar ayakta ama hiçbir şey yanıt vermiyorsa, herhangi bir şeyi yeniden bağlamadan önce yönlendirme ve politikayı kontrol edin.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Şunları arayın:

- DM gönderenleri için eşleştirmenin beklemede olması.
- Grup bahsetme kısıtlaması (`requireMention`, `mentionPatterns`).
- Kanal/grup izin listesi uyumsuzlukları.

Yaygın imzalar:

- `drop guild message (mention required` → bahsedilene kadar grup mesajı yok sayılır.
- `pairing request` → gönderenin onaya ihtiyacı var.
- `blocked` / `allowlist` → gönderen/kanal politika tarafından filtrelendi.

İlgili:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Gösterge paneli kontrol arayüzü bağlantısı

Gösterge paneli/kontrol arayüzü bağlanmıyorsa, URL'yi, kimlik doğrulama modunu ve güvenli bağlam varsayımlarını doğrulayın.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Şunları arayın:

- Doğru probe URL'si ve gösterge paneli URL'si.
- İstemci ile gateway arasında kimlik doğrulama modu/belirteci uyumsuzluğu.
- Cihaz kimliği gerektiği hâlde HTTP kullanımı.

Yaygın imzalar:

- `device identity required` → güvenli olmayan bağlam veya eksik cihaz kimlik doğrulaması.
- `unauthorized` / yeniden bağlanma döngüsü → belirteç/parola uyumsuzluğu.
- `gateway connect failed:` → yanlış ana makine/port/url hedefi.

İlgili:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway hizmeti çalışmıyor

Hizmet kurulu ancak süreç ayakta kalmıyorsa bunu kullanın.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Şunları arayın:

- Çıkış ipuçlarıyla birlikte `Runtime: stopped`.
- Hizmet yapılandırması uyumsuzluğu (`Config (cli)` ile `Config (service)`).
- Port/dinleyici çakışmaları.

Yaygın imzalar:

- `Gateway start blocked: set gateway.mode=local` → yerel gateway modu etkin değil.
- `refusing to bind gateway ... without auth` → belirteç/parola olmadan loopback dışı bağlama.
- `another gateway instance is already listening` / `EADDRINUSE` → port çakışması.

İlgili:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Kanal bağlı, mesajlar akmıyor

Kanal durumu bağlı ancak mesaj akışı durmuşsa, politika, izinler ve kanala özgü teslim kurallarına odaklanın.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Şunları arayın:

- DM politikası (`pairing`, `allowlist`, `open`, `disabled`).
- Grup izin listesi ve bahsetme gereksinimleri.
- Eksik kanal API izinleri/kapsamları.

Yaygın imzalar:

- `mention required` → mesaj grup bahsetme politikası tarafından yok sayıldı.
- `pairing` / bekleyen onay izleri → gönderen onaylı değil.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → kanal kimlik doğrulama/izin sorunu.

İlgili:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron ve heartbeat teslimi

Cron veya heartbeat çalışmadıysa ya da teslim edilmediyse, önce zamanlayıcı durumunu, ardından teslim hedefini doğrulayın.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Şunları arayın:

- Cron etkin ve bir sonraki uyanış mevcut.
- İş çalıştırma geçmişi durumu (`ok`, `skipped`, `error`).
- Heartbeat atlama nedenleri (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Yaygın imzalar:

- `cron: scheduler disabled; jobs will not run automatically` → cron devre dışı.
- `cron: timer tick failed` → zamanlayıcı tik'i başarısız; dosya/log/çalışma zamanı hatalarını kontrol edin.
- `heartbeat skipped` ile birlikte `reason=quiet-hours` → etkin saatler penceresinin dışında.
- `heartbeat: unknown accountId` → heartbeat teslim hedefi için geçersiz hesap kimliği.

İlgili:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Eşleştirilmiş düğüm aracı başarısız

Bir düğüm eşleştirilmiş ancak araçlar başarısızsa, ön plan, izin ve onay durumunu izole edin.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Şunları arayın:

- Beklenen yeteneklerle çevrimiçi düğüm.
- Kamera/mikrofon/konum/ekran için işletim sistemi izinleri.
- Çalıştırma onayları ve izin listesi durumu.

Yaygın imzalar:

- `NODE_BACKGROUND_UNAVAILABLE` → düğüm uygulaması ön planda olmalı.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → eksik işletim sistemi izni.
- `SYSTEM_RUN_DENIED: approval required` → çalıştırma onayı beklemede.
- `SYSTEM_RUN_DENIED: allowlist miss` → komut izin listesi tarafından engellendi.

İlgili:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Tarayıcı aracı başarısız

Gateway'in kendisi sağlıklı olmasına rağmen tarayıcı aracı eylemleri başarısız oluyorsa bunu kullanın.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Şunları arayın:

- Geçerli tarayıcı yürütülebilir dosya yolu.
- CDP profilinin erişilebilirliği.
- `profile="chrome"` için eklenti röle sekmesi iliştirmesi.

Yaygın imzalar:

- `Failed to start Chrome CDP on port` → tarayıcı süreci başlatılamadı.
- `browser.executablePath not found` → yapılandırılan yol geçersiz.
- `Chrome extension relay is running, but no tab is connected` → eklenti rölesi iliştirilmedi.
- `Browser attachOnly is enabled ... not reachable` → yalnızca iliştirilen profilin erişilebilir hedefi yok.

İlgili:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Güncelleme yaptıysanız ve bir şeyler aniden bozulduysa

Güncelleme sonrası bozulmaların çoğu yapılandırma kayması ya da artık daha sıkı varsayılanların uygulanmasından kaynaklanır.

### 1. Kimlik doğrulama ve URL geçersiz kılma davranışı değişti

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Bakılacaklar:

- `gateway.mode=remote` ise, yerel hizmetiniz sağlamken CLI çağrıları uzak hedefi işaret ediyor olabilir.
- Açık `--url` çağrıları, saklanan kimlik bilgilerine geri dönmez.

Yaygın imzalar:

- `gateway connect failed:` → yanlış URL hedefi.
- `unauthorized` → uç nokta erişilebilir ancak kimlik doğrulama yanlış.

### 2. Bağlama ve kimlik doğrulama korkulukları daha sıkı

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Bakılacaklar:

- Loopback dışı bağlamalar (`lan`, `tailnet`, `custom`) için kimlik doğrulama yapılandırılmalıdır.
- `gateway.token` gibi eski anahtarlar `gateway.auth.token` yerine geçmez.

Yaygın imzalar:

- `refusing to bind gateway ... without auth` → bağlama+kimlik doğrulama uyumsuzluğu.
- Çalışma zamanı çalışırken `RPC probe: failed` → gateway canlı ancak mevcut kimlik doğrulama/url ile erişilemez.

### 3. Eşleştirme ve cihaz kimliği durumu değişti

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

Bakılacaklar:

- Gösterge paneli/düğümler için bekleyen cihaz onayları.
- Politika veya kimlik değişikliklerinden sonra bekleyen DM eşleştirme onayları.

Yaygın imzalar:

- `device identity required` → cihaz kimlik doğrulaması karşılanmadı.
- `pairing required` → gönderen/cihaz onaylanmalıdır.

Kontrollerden sonra hizmet yapılandırması ile çalışma zamanı hâlâ uyuşmuyorsa, aynı profil/durum dizininden hizmet meta verilerini yeniden yükleyin:

```bash
openclaw gateway install --force
openclaw gateway restart
```

İlgili:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
