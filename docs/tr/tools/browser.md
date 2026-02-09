---
summary: "Entegre tarayıcı kontrol hizmeti + eylem komutları"
read_when:
  - 13. Ajan kontrollü tarayıcı otomasyonu ekleme
  - OpenClaw’ın kendi Chrome’unuzla neden etkileşime girdiğini hata ayıklarken
  - macOS uygulamasında tarayıcı ayarları ve yaşam döngüsünü uygularken
title: "Tarayıcı (OpenClaw tarafından yönetilen)"
---

# Tarayıcı (openclaw-managed)

OpenClaw, ajanın kontrol ettiği **özel bir Chrome/Brave/Edge/Chromium profili** çalıştırabilir.
Bu profil kişisel tarayıcınızdan yalıtılmıştır ve Gateway içinde
küçük bir yerel kontrol hizmeti (yalnızca loopback) aracılığıyla yönetilir.

Başlangıç seviyesi bakış:

- Bunu **ayrı, yalnızca ajana ait bir tarayıcı** olarak düşünün.
- `openclaw` profili kişisel tarayıcı profilinize **dokunmaz**.
- Ajan güvenli bir şeritte **sekme açabilir, sayfaları okuyabilir, tıklayabilir ve yazı yazabilir**.
- Varsayılan `chrome` profili, uzantı rölesi üzerinden **sistem varsayılan Chromium tarayıcısını** kullanır; yalıtılmış yönetilen tarayıcı için `openclaw`’ye geçin.

## Neler elde edersiniz

- **openclaw** adlı ayrı bir tarayıcı profili (varsayılan olarak turuncu vurgu).
- Deterministik sekme denetimi (listeleme/açma/odaklama/kapatma).
- Ajan eylemleri (tıklama/yazma/sürükleme/seçme), anlık görüntüler, ekran görüntüleri, PDF’ler.
- İsteğe bağlı çoklu profil desteği (`openclaw`, `work`, `remote`, ...).

Bu tarayıcı günlük kullanımınız için **değildir**. Ajan otomasyonu ve doğrulaması için güvenli,
yalıtılmış bir yüzeydir.

## Hızlı başlangıç

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

“Browser disabled” görürseniz, yapılandırmada etkinleştirin (aşağıya bakın) ve
Gateway’i yeniden başlatın.

## Profiller: `openclaw` vs `chrome`

- `openclaw`: yönetilen, yalıtılmış tarayıcı (uzantı gerekmez).
- `chrome`: **sistem tarayıcınıza** uzantı rölesi (bir sekmeye OpenClaw
  uzantısının bağlanmasını gerektirir).

Varsayılan olarak yönetilen modu istiyorsanız `browser.defaultProfile: "openclaw"`’ı ayarlayın.

## Yapılandırma

Tarayıcı ayarları `~/.openclaw/openclaw.json` içinde bulunur.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

Notlar:

- Tarayıcı kontrol hizmeti, `gateway.port`’den türetilen bir bağlantı noktasında loopback’e bağlanır
  (varsayılan: `18791`, yani gateway + 2). Röle bir sonraki bağlantı noktasını kullanır (`18792`).
- Gateway bağlantı noktasını (`gateway.port` veya `OPENCLAW_GATEWAY_PORT`) geçersiz kılarsanız,
  türetilen tarayıcı bağlantı noktaları aynı “aile”de kalacak şekilde kayar.
- `cdpUrl`, ayarlanmadığında röle bağlantı noktasına varsayılanlanır.
- `remoteCdpTimeoutMs`, uzak (loopback olmayan) CDP erişilebilirlik kontrolleri için geçerlidir.
- `remoteCdpHandshakeTimeoutMs`, uzak CDP WebSocket erişilebilirlik kontrolleri için geçerlidir.
- `attachOnly: true`, “asla yerel bir tarayıcı başlatma; yalnızca zaten çalışıyorsa bağlan” anlamına gelir.
- `color` + profil başına `color`, hangi profilin etkin olduğunu görebilmeniz için tarayıcı arayüzünü renklendirir.
- Varsayılan profil `chrome`’tür (uzantı rölesi). Yönetilen tarayıcı için `defaultProfile: "openclaw"`’ü kullanın.
- Otomatik algılama sırası: Chromium tabanlıysa sistem varsayılan tarayıcı; aksi halde Chrome → Brave → Edge → Chromium → Chrome Canary.
- Yerel `openclaw` profilleri `cdpPort`/`cdpUrl`’yi otomatik atar — bunları yalnızca uzak CDP için ayarlayın.

## Brave (veya başka bir Chromium tabanlı tarayıcı) kullanma

**Sistem varsayılan** tarayıcınız Chromium tabanlıysa (Chrome/Brave/Edge vb.),
OpenClaw bunu otomatik olarak kullanır. Otomatik algılamayı geçersiz kılmak için
`browser.executablePath`’i ayarlayın:

CLI örneği:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## Yerel ve uzak kontrol

- **Yerel kontrol (varsayılan):** Gateway loopback kontrol hizmetini başlatır ve yerel bir tarayıcıyı açabilir.
- **Uzak kontrol (node ana makinesi):** Tarayıcının bulunduğu makinede bir node host çalıştırın; Gateway tarayıcı eylemlerini buna proxy’ler.
- **Uzak CDP:** `browser.profiles.<name>.cdpUrl` (veya `browser.cdpUrl`) ayarlayarak
  uzak bir Chromium tabanlı tarayıcıya bağlanın. Bu durumda OpenClaw yerel bir tarayıcı başlatmaz.

Uzak CDP URL’leri kimlik doğrulama içerebilir:

- Sorgu belirteçleri (ör. `https://provider.example?token=<token>`)
- HTTP Basic auth (ör. `https://user:pass@provider.example`)

OpenClaw, `/json/*` uç noktalarını çağırırken ve CDP WebSocket’e bağlanırken
kimlik doğrulamayı korur. Belirteçleri yapılandırma dosyalarına commit etmek yerine
ortam değişkenlerini veya gizli anahtar yöneticilerini tercih edin.

## Node tarayıcı proxy’si (sıfır yapılandırmalı varsayılan)

Tarayıcınızın bulunduğu makinede bir **node host** çalıştırırsanız, OpenClaw
herhangi ek tarayıcı yapılandırması olmadan tarayıcı araç çağrılarını otomatik olarak
o node’a yönlendirebilir.
Bu, uzak Gateway’ler için varsayılan yoldur.

Notlar:

- Node host, yerel tarayıcı kontrol sunucusunu bir **proxy komutu** aracılığıyla açığa çıkarır.
- Profiller, node’un kendi `browser.profiles` yapılandırmasından gelir (yerel ile aynı).
- İstemiyorsanız devre dışı bırakın:
  - Node üzerinde: `nodeHost.browserProxy.enabled=false`
  - Gateway üzerinde: `gateway.nodes.browser.mode="off"`

## Browserless (barındırılan uzak CDP)

[Browserless](https://browserless.io), HTTPS üzerinden CDP uç noktaları sunan
barındırılan bir Chromium hizmetidir. Bir OpenClaw tarayıcı profilini
Browserless bölge uç noktasına yönlendirebilir ve API anahtarınızla kimlik doğrulaması yapabilirsiniz.

Örnek:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

Notlar:

- `<BROWSERLESS_API_KEY>`’yi gerçek Browserless belirtecinizle değiştirin.
- Browserless hesabınıza uygun bölge uç noktasını seçin (belgelerine bakın).

## Güvenlik

Temel fikirler:

- Tarayıcı kontrolü yalnızca loopback’tir; erişim Gateway’in kimlik doğrulaması veya node eşlemesi üzerinden akar.
- Gateway’i ve tüm node host’ları özel bir ağda (Tailscale) tutun; herkese açık maruziyetten kaçının.
- Uzak CDP URL’lerini/belirteçlerini gizli bilgi olarak değerlendirin; ortam değişkenlerini veya bir gizli anahtar yöneticisini tercih edin.

Uzak CDP ipuçları:

- Mümkünse HTTPS uç noktalarını ve kısa ömürlü belirteçleri tercih edin.
- Uzun ömürlü belirteçleri doğrudan yapılandırma dosyalarına gömmekten kaçının.

## Profiller (çoklu tarayıcı)

OpenClaw birden fazla adlandırılmış profili (yönlendirme yapılandırmaları) destekler. Profiller şunlar olabilir:

- **openclaw-managed**: kendi kullanıcı veri dizini + CDP bağlantı noktasına sahip özel bir Chromium tabanlı tarayıcı örneği
- **remote**: açık bir CDP URL’si (başka bir yerde çalışan Chromium tabanlı tarayıcı)
- **extension relay**: yerel röle + Chrome uzantısı üzerinden mevcut Chrome sekmeleriniz

Varsayılanlar:

- `openclaw` profili yoksa otomatik oluşturulur.
- `chrome` profili, Chrome uzantı rölesi için yerleşiktir (varsayılan olarak `http://127.0.0.1:18792`’yi işaret eder).
- Yerel CDP bağlantı noktaları varsayılan olarak **18800–18899** aralığından tahsis edilir.
- Bir profili silmek, yerel veri dizinini Çöp Kutusu’na taşır.

Tüm kontrol uç noktaları `?profile=<name>` kabul eder; CLI `--browser-profile` kullanır.

## Chrome uzantı rölesi (mevcut Chrome’unuzu kullanın)

OpenClaw, yerel bir CDP rölesi + Chrome uzantısı aracılığıyla **mevcut Chrome sekmelerinizi**
(ayrı bir “openclaw” Chrome örneği olmadan) de kontrol edebilir.

Tam kılavuz: [Chrome uzantısı](/tools/chrome-extension)

Akış:

- Gateway yerel olarak (aynı makinede) çalışır veya tarayıcı makinesinde bir node host çalışır.
- Yerel bir **röle sunucusu**, bir loopback `cdpUrl`’te dinler (varsayılan: `http://127.0.0.1:18792`).
- Kontrol etmek istediğiniz sekmede **OpenClaw Browser Relay** uzantı simgesine tıklarsınız (otomatik bağlanmaz).
- Ajan, doğru profili seçerek normal `browser` aracı üzerinden o sekmeyi kontrol eder.

Gateway başka bir yerde çalışıyorsa, Gateway’in tarayıcı eylemlerini proxy’leyebilmesi için
tarayıcı makinesinde bir node host çalıştırın.

### Sandbox’lanmış oturumlar

Ajan oturumu sandbox’lıysa, `browser` aracı varsayılan olarak `target="sandbox"`’ye (sandbox tarayıcı) geçebilir.
Chrome uzantı rölesini devralmak ana makine tarayıcı kontrolü gerektirir; bu nedenle ya:

- oturumu sandbox’sız çalıştırın veya
- `agents.defaults.sandbox.browser.allowHostControl: true`’i ayarlayın ve aracı çağırırken `target="host"`’u kullanın.

### Kurulum

1. Uzantıyı yükleyin (dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → “Developer mode”u etkinleştirin
- “Load unpacked” → `openclaw browser extension path` tarafından yazdırılan dizini seçin
- Uzantıyı sabitleyin, ardından kontrol etmek istediğiniz sekmede tıklayın (rozet `ON` gösterir).

2. Kullanın:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Ajan aracı: `browser` ile `profile="chrome"`

İsteğe bağlı: farklı bir ad veya röle bağlantı noktası istiyorsanız, kendi profilinizi oluşturun:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Notlar:

- Bu mod, çoğu işlem için Playwright-on-CDP’ye dayanır (ekran görüntüleri/anlık görüntüler/eylemler).
- Ayırmak için uzantı simgesine tekrar tıklayın.

## Yalıtım garantileri

- **Özel kullanıcı veri dizini**: kişisel tarayıcı profilinize asla dokunmaz.
- **Özel bağlantı noktaları**: geliştirme iş akışlarıyla çakışmaları önlemek için `9222`’dan kaçınır.
- **Deterministik sekme denetimi**: “son sekme” yerine `targetId` ile hedefleme.

## Tarayıcı seçimi

Yerel olarak başlatırken OpenClaw, mevcut olan ilkini seçer:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

`browser.executablePath` ile geçersiz kılabilirsiniz.

Platformlar:

- macOS: `/Applications` ve `~/Applications`’yi kontrol eder.
- Linux: `google-chrome`, `brave`, `microsoft-edge`, `chromium` vb. arar.
- Windows: yaygın kurulum konumlarını kontrol eder.

## Kontrol API’si (isteğe bağlı)

Yalnızca yerel entegrasyonlar için Gateway, küçük bir loopback HTTP API’si sunar:

- Durum/başlat/durdur: `GET /`, `POST /start`, `POST /stop`
- Sekmeler: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Anlık görüntü/ekran görüntüsü: `GET /snapshot`, `POST /screenshot`
- Eylemler: `POST /navigate`, `POST /act`
- Kancalar: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- İndirmeler: `POST /download`, `POST /wait/download`
- Hata ayıklama: `GET /console`, `POST /pdf`
- Hata ayıklama: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Ağ: `POST /response/body`
- Durum: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- Durum: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Ayarlar: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Tüm uç noktalar `?profile=<name>` kabul eder.

### Playwright gereksinimi

Bazı özellikler (gezinti/eylem/AI anlık görüntü/rol anlık görüntüsü, öğe ekran görüntüleri, PDF)
Playwright gerektirir. Playwright yüklü değilse bu uç noktalar net bir 501
hatası döndürür. ARIA anlık görüntüleri ve temel ekran görüntüleri openclaw-managed Chrome için
çalışmaya devam eder.
Chrome uzantı rölesi sürücüsü için ARIA anlık görüntüleri ve ekran görüntüleri Playwright gerektirir.

`Playwright is not available in this gateway build` görürseniz, tam
Playwright paketini (`playwright-core` değil) yükleyin ve gateway’i yeniden başlatın
veya OpenClaw’ı tarayıcı desteğiyle yeniden yükleyin.

#### Docker Playwright kurulumu

Gateway Docker’da çalışıyorsa `npx playwright`’ten kaçının (npm geçersiz kılma çakışmaları).
Bunun yerine paketli CLI’yi kullanın:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Tarayıcı indirmelerini kalıcı yapmak için `PLAYWRIGHT_BROWSERS_PATH`’yı ayarlayın (örneğin,
`/home/node/.cache/ms-playwright`) ve `/home/node`’nin
`OPENCLAW_HOME_VOLUME` veya bir bind mount ile kalıcı olduğundan emin olun. [Docker](/install/docker) bölümüne bakın.

## Nasıl çalışır (dahili)

Yüksek seviyeli akış:

- Küçük bir **kontrol sunucusu** HTTP isteklerini kabul eder.
- **CDP** üzerinden Chromium tabanlı tarayıcılara (Chrome/Brave/Edge/Chromium) bağlanır.
- Gelişmiş eylemler için (tıklama/yazma/anlık görüntü/PDF) CDP üzerinde **Playwright** kullanır.
- Playwright eksikse yalnızca Playwright gerektirmeyen işlemler kullanılabilir.

Bu tasarım, yerel/uzak tarayıcılar ve profiller arasında geçiş yapmanıza izin verirken
ajanı kararlı ve deterministik bir arayüzde tutar.

## CLI hızlı başvuru

Tüm komutlar, belirli bir profili hedeflemek için `--browser-profile <name>` kabul eder.
Tüm komutlar ayrıca makine tarafından okunabilir çıktı (kararlı yükler) için `--json` kabul eder.

Temeller:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

İnceleme:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

Eylemler:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

14. Durum:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

Notlar:

- `upload` ve `dialog` **hazırlama** çağrılarıdır; seçici/iletişim kutusunu tetikleyen tıklama/tuş basımından önce çalıştırın.
- `upload`, dosya girdilerini `--input-ref` veya `--element` ile doğrudan ayarlayabilir.
- `snapshot`:
  - `--format ai` (Playwright yüklüyken varsayılan): sayısal referanslar (`aria-ref="<n>"`) içeren bir AI anlık görüntüsü döndürür.
  - `--format aria`: erişilebilirlik ağacını döndürür (referans yok; yalnızca inceleme).
  - `--efficient` (veya `--mode efficient`): kompakt rol anlık görüntüsü ön ayarı (etkileşimli + kompakt + derinlik + daha düşük maxChars).
  - Yapılandırma varsayılanı (yalnızca araç/CLI): çağıran bir mod geçmezse verimli anlık görüntüler kullanmak için `browser.snapshotDefaults.mode: "efficient"`’yi ayarlayın (bkz. [Gateway yapılandırması](/gateway/configuration#browser-openclaw-managed-browser)).
  - Rol anlık görüntüsü seçenekleri (`--interactive`, `--compact`, `--depth`, `--selector`), `ref=e12` gibi referanslarla rol tabanlı bir anlık görüntüyü zorlar.
  - `--frame "<iframe selector>"`, rol anlık görüntülerini bir iframe’e sınırlar ( `e12` gibi rol referanslarıyla eşleşir).
  - `--interactive`, etkileşimli öğelerin düz, seçmesi kolay bir listesini üretir (eylemleri sürmek için en iyisi).
  - `--labels`, bindirilmiş referans etiketleriyle yalnızca görünüm alanına ait bir ekran görüntüsü ekler (`MEDIA:<path>` yazdırır).
- `click`/`type`/vb., `snapshot`’den bir `ref` gerektirir (sayısal `12` veya rol referansı `e12`).
  CSS seçicileri eylemler için bilinçli olarak desteklenmez.

## 15. Anlık görüntüler ve referanslar

OpenClaw iki “anlık görüntü” stilini destekler:

- **AI anlık görüntüsü (sayısal referanslar)**: `openclaw browser snapshot` (varsayılan; `--format ai`)
  - Çıktı: sayısal referanslar içeren bir metin anlık görüntüsü.
  - Eylemler: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Dahili olarak referans, Playwright’ın `aria-ref`’i üzerinden çözülür.

- **Rol anlık görüntüsü ( `e12` gibi rol referansları)**: `openclaw browser snapshot --interactive` (veya `--compact`, `--depth`, `--selector`, `--frame`)
  - Çıktı: `[ref=e12]` (ve isteğe bağlı `[nth=1]`) içeren rol tabanlı bir liste/ağaç.
  - Eylemler: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Dahili olarak referans, `getByRole(...)` (çoğaltmalar için `nth()` ile birlikte) üzerinden çözülür.
  - Bindirilmiş `e12` etiketleriyle bir görünüm alanı ekran görüntüsü eklemek için `--labels` ekleyin.

Referans davranışı:

- Referanslar **gezintiler arasında kararlı değildir**; bir şey başarısız olursa `snapshot`’ü yeniden çalıştırın ve yeni bir referans kullanın.
- Rol anlık görüntüsü `--frame` ile alındıysa, rol referansları bir sonraki rol anlık görüntüsüne kadar o iframe’e kapsamlıdır.

## 16. Bekleme güçlendirmeleri

Yalnızca zaman/metin değil, daha fazlasını bekleyebilirsiniz:

- URL bekleme (Playwright tarafından desteklenen glob’lar):
  - `openclaw browser wait --url "**/dash"`
- Yükleme durumu bekleme:
  - `openclaw browser wait --load networkidle`
- Bir JS önermesini bekleme:
  - `openclaw browser wait --fn "window.ready===true"`
- Bir seçicinin görünür olmasını bekleme:
  - `openclaw browser wait "#main"`

Bunlar birleştirilebilir:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Hata ayıklama iş akışları

Bir eylem başarısız olduğunda (örn. “görünür değil”, “strict mode ihlali”, “üstü kapalı”):

1. `openclaw browser snapshot --interactive`
2. `click <ref>` / `type <ref>` kullanın (etkileşimli modda rol referanslarını tercih edin)
3. Hâlâ başarısızsa: Playwright’ın neyi hedeflediğini görmek için `openclaw browser highlight <ref>`
4. Sayfa garip davranıyorsa:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Derin hata ayıklama için bir iz kaydedin:
   - `openclaw browser trace start`
   - sorunu yeniden üretin
   - `openclaw browser trace stop` (`TRACE:<path>` yazdırır)

## JSON çıktısı

`--json`, betikleme ve yapılandırılmış araçlar içindir.

Örnekler:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON’daki rol anlık görüntüleri, araçların yük boyutu ve yoğunluğu hakkında akıl yürütebilmesi için
`refs`’a ek olarak küçük bir `stats` bloğu (satırlar/karakterler/referanslar/etkileşimli) içerir.

## 17. Durum ve ortam ayar düğmeleri

Bunlar “siteyi X gibi davranmaya zorla” iş akışları için kullanışlıdır:

- Çerezler: `cookies`, `cookies set`, `cookies clear`
- Depolama: `storage local|session get|set|clear`
- Çevrimdışı: `set offline on|off`
- Başlıklar: `set headers --json '{"X-Debug":"1"}'` (veya `--clear`)
- HTTP basic auth: `set credentials user pass` (veya `--clear`)
- Coğrafi konum: `set geo <lat> <lon> --origin "https://example.com"` (veya `--clear`)
- Medya: `set media dark|light|no-preference|none`
- Saat dilimi / yerel ayar: `set timezone ...`, `set locale ...`
- Cihaz / görünüm alanı:
  - `set device "iPhone 14"` (Playwright cihaz ön ayarları)
  - `set viewport 1280 720`

## Güvenlik ve gizlilik

- openclaw tarayıcı profili oturum açılmış oturumlar içerebilir; hassas olarak değerlendirin.
- `browser act kind=evaluate` / `openclaw browser evaluate` ve `wait --fn`,
  sayfa bağlamında rastgele JavaScript çalıştırır. Prompt injection bunu yönlendirebilir. İhtiyacınız yoksa `browser.evaluateEnabled=false` ile devre dışı bırakın.
- Girişler ve anti-bot notları (X/Twitter vb.) için [Tarayıcı girişi + X/Twitter gönderimi](/tools/browser-login) bölümüne bakın.
- Gateway/node host’u özel tutun (loopback veya tailnet-only).
- Uzak CDP uç noktaları güçlüdür; tünelleyin ve koruyun.

## Sorun giderme

Linux’a özgü sorunlar (özellikle snap Chromium) için
[Tarayıcı sorun giderme](/tools/browser-linux-troubleshooting) bölümüne bakın.

## Ajan araçları + kontrolün nasıl çalıştığı

Ajan, tarayıcı otomasyonu için **tek bir araç** alır:

- `browser` — durum/başlat/durdur/sekme/aç/odakla/kapat/anlık görüntü/ekran görüntüsü/gezinti/eylem

18. Nasıl eşlendiği:

- `browser snapshot`, kararlı bir UI ağacı (AI veya ARIA) döndürür.
- `browser act`, tıklama/yazma/sürükleme/seçme için anlık görüntü `ref` kimliklerini kullanır.
- `browser screenshot`, pikselleri yakalar (tam sayfa veya öğe).
- `browser`, şunları kabul eder:
  - Adlandırılmış bir tarayıcı profilini seçmek için `profile` (openclaw, chrome veya uzak CDP).
  - Tarayıcının nerede yaşadığını seçmek için `target` (`sandbox` | `host` | `node`).
  - Sandbox’lı oturumlarda `target: "host"`, `agents.defaults.sandbox.browser.allowHostControl=true` gerektirir.
  - `target` atlanırsa: sandbox’lı oturumlar varsayılan olarak `sandbox`, sandbox’sız oturumlar varsayılan olarak `host` kullanır.
  - Tarayıcı yetenekli bir node bağlıysa, `target="host"` veya `target="node"`’i sabitlemediğiniz sürece araç otomatik yönlendirme yapabilir.

Bu, ajanı deterministik tutar ve kırılgan seçicilerden kaçınır.
