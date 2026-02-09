---
summary: "Gateway için tarayıcı tabanlı kontrol arayüzü (sohbet, düğümler, yapılandırma)"
read_when:
  - Gateway’i bir tarayıcıdan işletmek istiyorsanız
  - SSH tünelleri olmadan Tailnet erişimi istiyorsanız
title: "Kontrol Arayüzü"
---

# Kontrol Arayüzü (tarayıcı)

Kontrol Arayüzü, Gateway tarafından sunulan küçük bir **Vite + Lit** tek sayfalı uygulamadır:

- varsayılan: `http://<host>:18789/`
- isteğe bağlı önek: `gateway.controlUi.basePath` ayarlayın (örn. `/openclaw`)

Aynı port üzerinden **doğrudan Gateway WebSocket**’ine konuşur.

## Hızlı açma (yerel)

Gateway aynı bilgisayarda çalışıyorsa şunu açın:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (veya [http://localhost:18789/](http://localhost:18789/))

Sayfa yüklenmezse önce Gateway’i başlatın: `openclaw gateway`.

Kimlik doğrulama, WebSocket el sıkışması sırasında şu yollarla sağlanır:

- `connect.params.auth.token`
- `connect.params.auth.password`
  Gösterge paneli ayarlar bölümü bir belirteç saklamanıza izin verir; parolalar kalıcı olarak tutulmaz.
  Başlangıç sihirbazı varsayılan olarak bir gateway belirteci üretir; ilk bağlantıda bunu buraya yapıştırın.

## Cihaz eşleştirme (ilk bağlantı)

Yeni bir tarayıcı veya cihazdan Kontrol Arayüzü’ne bağlandığınızda, Gateway
aynı Tailnet’te `gateway.auth.allowTailscale: true` olsanız bile **tek seferlik bir eşleştirme onayı**
gerektirir. Bu, yetkisiz erişimi önlemek için bir güvenlik önlemidir.

**Göreceğiniz mesaj:** "disconnected (1008): pairing required"

**Cihazı onaylamak için:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Onaylandıktan sonra cihaz hatırlanır ve `openclaw devices revoke --device <id> --role <role>` ile geri almadıkça
yeniden onay gerektirmez. Belirteç döndürme ve iptal için
[Devices CLI](/cli/devices) bölümüne bakın.

**Notlar:**

- Yerel bağlantılar (`127.0.0.1`) otomatik olarak onaylanır.
- Uzak bağlantılar (LAN, Tailnet, vb.) açık onay gerektirir.
- Her tarayıcı profili benzersiz bir cihaz kimliği üretir; bu nedenle tarayıcı
  değiştirmek veya tarayıcı verilerini temizlemek yeniden eşleştirme gerektirir.

## Neler yapabilir (bugün)

- Gateway WS üzerinden modelle sohbet (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Stream tool calls + live tool output cards in Chat (agent events)
- Kanallar: WhatsApp/Telegram/Discord/Slack + eklenti kanalları (Mattermost, vb.) durum + QR ile giriş + kanal başına yapılandırma (`channels.status`, `web.login.*`, `config.patch`)
- Örnekler: varlık listesi + yenileme (`system-presence`)
- Oturumlar: liste + oturum başına düşünme/ayrıntılı geçersiz kılmalar (`sessions.list`, `sessions.patch`)
- Cron işleri: listele/ekle/çalıştır/etkinleştir/devre dışı bırak + çalışma geçmişi (`cron.*`)
- Skills: durum, etkinleştir/devre dışı bırak, yükle, API anahtarı güncellemeleri (`skills.*`)
- Düğümler: liste + yetenekler (`node.list`)
- Çalıştırma onayları: gateway veya düğüm izin listelerini düzenleme + `exec host=gateway/node` için politika sorma (`exec.approvals.*`)
- Yapılandırma: `~/.openclaw/openclaw.json` görüntüleme/düzenleme (`config.get`, `config.set`)
- Yapılandırma: doğrulama ile uygula + yeniden başlat (`config.apply`) ve son etkin oturumu uyandır
- Yapılandırma yazımları, eşzamanlı düzenlemelerin üzerine yazılmasını önlemek için bir temel karma (base-hash) koruması içerir
- Yapılandırma şeması + form oluşturma (`config.schema`, eklenti + kanal şemaları dahil); Ham JSON düzenleyici kullanılabilir durumda kalır
- Hata ayıklama: durum/sağlık/modeller anlık görüntüleri + olay günlüğü + manuel RPC çağrıları (`status`, `health`, `models.list`)
- Günlükler: filtre/dışa aktarma ile gateway dosya günlüklerinin canlı takibi (`logs.tail`)
- Güncelleme: paket/git güncellemesi çalıştır + yeniden başlat (`update.run`) ve yeniden başlatma raporu

Cron işleri paneli notları:

- İzole işler için teslimat varsayılan olarak duyuru özeti gönderir. Yalnızca dahili çalıştırmalar istiyorsanız “none” seçebilirsiniz.
- “announce” seçildiğinde kanal/hedef alanları görünür.

## Sohbet davranışı

- `chat.send` **engelleyici değildir**: `{ runId, status: "started" }` ile hemen onaylar ve yanıt `chat` olaylarıyla akış halinde gelir.
- Aynı `idempotencyKey` ile yeniden gönderme, çalışırken `{ status: "in_flight" }`, tamamlandıktan sonra `{ status: "ok" }` döndürür.
- `chat.inject`, oturum dökümüne bir asistan notu ekler ve yalnızca arayüz güncellemeleri için (ajan çalıştırma yok, kanal teslimi yok) bir `chat` olayı yayınlar.
- Durdur:
  - **Stop**’a tıklayın (`chat.abort` çağrılır)
  - Bant dışı iptal için `/stop` (veya `stop|esc|abort|wait|exit|interrupt`) yazın
  - `chat.abort`, bu oturum için tüm etkin çalıştırmaları iptal etmek üzere `{ sessionKey }`’yı destekler (`runId` yok)

## Tailnet erişimi (önerilir)

### Entegre Tailscale Serve (tercih edilen)

Gateway’i loopback’te tutun ve Tailscale Serve’ün HTTPS ile proxy’lemesine izin verin:

```bash
openclaw gateway --tailscale serve
```

Açın:

- `https://<magicdns>/` (veya yapılandırılmış `gateway.controlUi.basePath`)

Varsayılan olarak Serve istekleri, `gateway.auth.allowTailscale` `true` olduğunda
Tailscale kimlik başlıkları (`tailscale-user-login`) ile kimlik doğrulayabilir. OpenClaw,
`x-forwarded-for` adresini `tailscale whois` ile çözümleyerek kimliği doğrular ve
başlıkla eşleştirir; yalnızca istek Tailscale’in `x-forwarded-*` başlıklarıyla
loopback’e ulaştığında kabul eder. Serve trafiği için bile belirteç/parola
zorunlu kılmak istiyorsanız `gateway.auth.allowTailscale: false` ayarlayın (veya `gateway.auth.mode: "password"`’yi zorlayın).

### Tailnet’e bağla + belirteç

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Ardından açın:

- `http://<tailscale-ip>:18789/` (veya yapılandırılmış `gateway.controlUi.basePath`)

Belirteci arayüz ayarlarına yapıştırın (`connect.params.auth.token` olarak gönderilir).

## Güvensiz HTTP

Gösterge panelini düz HTTP üzerinden açarsanız (`http://<lan-ip>` veya `http://<tailscale-ip>`),
tarayıcı **güvenli olmayan bağlamda** çalışır ve WebCrypto’yu engeller. Varsayılan
olarak OpenClaw, cihaz kimliği olmadan Kontrol Arayüzü bağlantılarını **engeller**.

**Önerilen çözüm:** HTTPS kullanın (Tailscale Serve) veya arayüzü yerel olarak açın:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (gateway ana makinesinde)

**Düşürme örneği (HTTP üzerinden yalnızca belirteç):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

Bu, Kontrol Arayüzü için cihaz kimliği + eşleştirmeyi (HTTPS üzerinde bile) devre dışı bırakır. Yalnızca ağa güveniyorsanız kullanın.

HTTPS kurulumu için [Tailscale](/gateway/tailscale) bölümüne bakın.

## UI’yi derleme

Gateway, statik dosyaları `dist/control-ui`’ten sunar. Şununla derleyin:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

İsteğe bağlı mutlak taban (sabit varlık URL’leri istediğinizde):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Yerel geliştirme için (ayrı bir geliştirme sunucusu):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Ardından arayüzü Gateway WS URL’nize yönlendirin (örn. `ws://127.0.0.1:18789`).

## Hata ayıklama/test: geliştirme sunucusu + uzak Gateway

Kontrol Arayüzü statik dosyalardır; WebSocket hedefi yapılandırılabilir ve HTTP
kaynağından farklı olabilir. Bu, Vite geliştirme sunucusunu yerelde tutup
Gateway’in başka bir yerde çalıştığı durumlar için kullanışlıdır.

1. Arayüz geliştirme sunucusunu başlatın: `pnpm ui:dev`
2. Şuna benzer bir URL açın:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

İsteğe bağlı tek seferlik kimlik doğrulama (gerekirse):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Notlar:

- `gatewayUrl`, yüklemeden sonra localStorage’da saklanır ve URL’den kaldırılır.
- `token` localStorage’da saklanır; `password` yalnızca bellekte tutulur.
- `gatewayUrl` ayarlandığında, arayüz yapılandırma veya ortam kimlik bilgilerine geri dönmez.
  `token`’yi (veya `password`) açıkça sağlayın. Açık kimlik bilgileri olmaması hatadır.
- Gateway TLS arkasındayken (Tailscale Serve, HTTPS proxy, vb.) `wss://` kullanın.
- Tıklama kaçırmayı önlemek için `gatewayUrl` yalnızca üst düzey pencerede kabul edilir (gömülü değil).
- Çapraz kaynaklı geliştirme kurulumları için (örn. `pnpm ui:dev`’dan uzak bir Gateway’e),
  arayüz kaynağını `gateway.controlUi.allowedOrigins`’ye ekleyin.

Örnek:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Uzak erişim kurulum ayrıntıları: [Uzak erişim](/gateway/remote).
