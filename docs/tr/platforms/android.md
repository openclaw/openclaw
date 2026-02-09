---
summary: "Android uygulaması (node): bağlantı runbook'u + Canvas/Chat/Kamera"
read_when:
  - Android node'u eşleştirirken veya yeniden bağlarken
  - Android gateway keşfi ya da kimlik doğrulamayı hata ayıklarken
  - İstemciler arasında sohbet geçmişi eşitliğini doğrularken
title: "Android Uygulaması"
---

# Android Uygulaması (Node)

## Destek anlık görüntüsü

- Rol: yardımcı node uygulaması (Android Gateway barındırmaz).
- Gateway gerekli: evet (macOS, Linux veya WSL2 üzerinden Windows’ta çalıştırın).
- Yükleme: [Başlarken](/start/getting-started) + [Eşleştirme](/gateway/pairing).
- Gateway: [Runbook](/gateway) + [Yapılandırma](/gateway/configuration).
  - Protokoller: [Gateway protokolü](/gateway/protocol) (node’lar + kontrol düzlemi).

## Sistem denetimi

Sistem denetimi (launchd/systemd) Gateway ana makinesinde bulunur. [Gateway](/gateway) bölümüne bakın.

## Bağlantı Runbook’u

Android node uygulaması ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android, Gateway WebSocket’ine (varsayılan `ws://<host>:18789`) doğrudan bağlanır ve Gateway’e ait eşleştirmeyi kullanır.

### Ön koşullar

- Gateway’i “master” makinede çalıştırabiliyor olmalısınız.
- Android cihazı/emülatörü gateway WebSocket’ine erişebilmelidir:
  - mDNS/NSD ile aynı LAN, **veya**
  - Wide-Area Bonjour / unicast DNS-SD kullanarak aynı Tailscale tailnet’i (aşağıya bakın), **veya**
  - Manuel gateway ana makinesi/portu (geri dönüş)
- Gateway makinesinde (veya SSH üzerinden) CLI’yi (`openclaw`) çalıştırabiliyor olmalısınız.

### 1. Gateway’i başlatın

```bash
openclaw gateway --port 18789 --verbose
```

Confirm in logs you see something like:

- `listening on ws://0.0.0.0:18789`

Yalnızca tailnet kurulumları için (Vienna ⇄ London önerilir), gateway’i tailnet IP’sine bağlayın:

- Gateway ana makinesinde `~/.openclaw/openclaw.json` içinde `gateway.bind: "tailnet"` ayarlayın.
- Gateway’i / macOS menü çubuğu uygulamasını yeniden başlatın.

### 2. Keşfi doğrulayın (isteğe bağlı)

Gateway makinesinden:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Daha fazla hata ayıklama notu: [Bonjour](/gateway/bonjour).

#### Unicast DNS-SD üzerinden Tailnet (Vienna ⇄ London) keşfi

Android NSD/mDNS keşfi ağlar arasında çalışmaz. Android node’unuz ve gateway farklı ağlarda olup Tailscale ile bağlıysa, Wide-Area Bonjour / unicast DNS-SD kullanın:

1. Gateway ana makinesinde bir DNS-SD bölgesi (örnek `openclaw.internal.`) kurun ve `_openclaw-gw._tcp` kayıtlarını yayımlayın.
2. Seçtiğiniz alan adını bu DNS sunucusuna yönlendirecek şekilde Tailscale split DNS’i yapılandırın.

Ayrıntılar ve örnek CoreDNS yapılandırması: [Bonjour](/gateway/bonjour).

### 3. Android’den bağlanın

Android uygulamasında:

- Uygulama, gateway bağlantısını **foreground service** (kalıcı bildirim) ile canlı tutar.
- **Ayarlar**’ı açın.
- **Keşfedilen Gateway’ler** altında gateway’inizi seçin ve **Bağlan**’a dokunun.
- mDNS engelliyse **Gelişmiş → Manuel Gateway** (ana makine + port) ve **Manuel Bağlan**’ı kullanın.

İlk başarılı eşleştirmeden sonra Android, başlatıldığında otomatik yeniden bağlanır:

- Manuel uç nokta (etkinse), aksi halde
- Son keşfedilen gateway (en iyi çaba).

### 4. Eşleştirmeyi onaylayın (CLI)

Gateway makinesinde:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Eşleştirme ayrıntıları: [Gateway eşleştirme](/gateway/pairing).

### 5. Node’un bağlı olduğunu doğrulayın

- Node durumu üzerinden:

  ```bash
  openclaw nodes status
  ```

- Gateway üzerinden:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Sohbet + geçmiş

Android node’unun Sohbet sayfası, gateway’in **birincil oturum anahtarını** (`main`) kullanır; böylece geçmiş ve yanıtlar WebChat ve diğer istemcilerle paylaşılır:

- Geçmiş: `chat.history`
- Gönder: `chat.send`
- Anlık güncellemeler (en iyi çaba): `chat.subscribe` → `event:"chat"`

### 7. Canvas + kamera

#### Gateway Canvas Host (web içeriği için önerilir)

Node’un, ajanın diskte düzenleyebileceği gerçek HTML/CSS/JS göstermesini istiyorsanız, node’u Gateway canvas host’una yönlendirin.

Not: node’lar, `canvasHost.port` üzerinde bağımsız canvas host’unu kullanır (varsayılan `18793`).

1. Gateway ana makinesinde `~/.openclaw/workspace/canvas/index.html` oluşturun.

2. Node’u buna yönlendirin (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (isteğe bağlı): Her iki cihaz da Tailscale üzerindeyse, `.local` yerine MagicDNS adı veya tailnet IP’si kullanın; örn. `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

Bu sunucu HTML içine canlı yeniden yükleme istemcisi enjekte eder ve dosya değişikliklerinde yeniden yükler.
A2UI host’u `http://<gateway-host>:18793/__openclaw__/a2ui/` adresindedir.

Canvas komutları (yalnızca foreground):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (varsayılan iskelete dönmek için `{"url":""}` veya `{"url":"/"}` kullanın). `canvas.snapshot`, `{ format, base64 }`’u döndürür (varsayılan `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` eski takma ad)

Kamera komutları (yalnızca foreground; izin kontrollü):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Parametreler ve CLI yardımcıları için [Kamera node’u](/nodes/camera) bölümüne bakın.
