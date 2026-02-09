---
summary: "OpenClaw macOS yardımcı uygulaması (menü çubuğu + gateway broker)"
read_when:
  - macOS uygulama özelliklerini uygularken
  - macOS’te gateway yaşam döngüsünü veya düğüm köprülemesini değiştirirken
title: "macOS Uygulaması"
---

# OpenClaw macOS Yardımcı Uygulaması (menü çubuğu + gateway broker)

macOS uygulaması, OpenClaw için **menü çubuğu yardımcı uygulamasıdır**. İzinlerin
sahipliğini üstlenir, Gateway’e yerel olarak (launchd veya manuel) bağlanır/yönetir
ve macOS yeteneklerini bir düğüm olarak ajana sunar.

## Ne yapar

- Menü çubuğunda yerel bildirimleri ve durumu gösterir.
- TCC istemlerinin (Bildirimler, Erişilebilirlik, Ekran Kaydı, Mikrofon,
  Konuşma Tanıma, Otomasyon/AppleScript) sahipliğini üstlenir.
- Gateway’i çalıştırır veya ona bağlanır (yerel veya uzak).
- macOS’e özgü araçları açığa çıkarır (Canvas, Kamera, Ekran Kaydı, `system.run`).
- Yerel düğüm ana makinesi hizmetini **remote** modda (launchd) başlatır ve **local** modda durdurur.
- İsteğe bağlı olarak UI otomasyonu için **PeekabooBridge** barındırır.
- İstek üzerine npm/pnpm aracılığıyla global CLI’yi (`openclaw`) kurar (Gateway çalışma zamanı için bun önerilmez).

## Yerel vs uzak mod

- **Local** (varsayılan): uygulama, mevcutsa çalışan yerel bir Gateway’e bağlanır;
  aksi halde launchd hizmetini `openclaw gateway install` üzerinden etkinleştirir.
- **Remote**: uygulama, SSH/Tailscale üzerinden bir Gateway’e bağlanır ve asla
  yerel bir süreç başlatmaz.
  Uzak Gateway’in bu Mac’e erişebilmesi için yerel **düğüm ana makinesi hizmetini** başlatır.
  Uygulama, Gateway’i alt süreç olarak başlatmaz.

## Launchd denetimi

Uygulama, kullanıcı başına bir LaunchAgent’i `bot.molt.gateway` etiketiyle yönetir
(`--profile`/`OPENCLAW_PROFILE` kullanıldığında `bot.molt.<profile>`;
eski `com.openclaw.*` hâlâ unload eder).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Adlandırılmış bir profil çalıştırırken etiketi `bot.molt.<profile>` ile değiştirin.

LaunchAgent yüklü değilse, uygulamadan etkinleştirin veya
`openclaw gateway install` komutunu çalıştırın.

## Düğüm yetenekleri (mac)

macOS uygulaması kendisini bir düğüm olarak sunar. Yaygın komutlar:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Kamera: `camera.snap`, `camera.clip`
- Ekran: `screen.record`
- Sistem: `system.run`, `system.notify`

Düğüm, ajanların neye izin verildiğine karar verebilmesi için bir `permissions` haritası raporlar.

Düğüm hizmeti + uygulama IPC:

- Başsız düğüm ana makinesi hizmeti çalıştığında (remote mod), Gateway WS’ye bir düğüm olarak bağlanır.
- `system.run`, macOS uygulamasında (UI/TCC bağlamı) yerel bir Unix soketi üzerinden çalışır; istemler ve çıktı uygulama içinde kalır.

Diyagram (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec onayları (system.run)

`system.run`, macOS uygulamasındaki **Exec onayları** (Ayarlar → Exec onayları) tarafından denetlenir.
Güvenlik + sorma + izin listesi Mac üzerinde yerel olarak şurada saklanır:

```
~/.openclaw/exec-approvals.json
```

Örnek:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

Notlar:

- `allowlist` girdileri, çözümlenmiş ikili dosya yolları için glob desenleridir.
- İstemde “Her Zaman İzin Ver” seçilmesi, bu komutu izin listesine ekler.
- `system.run` ortam geçersiz kılmaları filtrelenir (`PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT` bırakılır) ve ardından uygulamanın ortamıyla birleştirilir.

## Derin bağlantılar

Uygulama, yerel eylemler için `openclaw://` URL şemasını kaydeder.

### `openclaw://agent`

Bir Gateway `agent` isteğini tetikler.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Sorgu parametreleri:

- `message` (gerekli)
- `sessionKey` (isteğe bağlı)
- `thinking` (isteğe bağlı)
- `deliver` / `to` / `channel` (isteğe bağlı)
- `timeoutSeconds` (isteğe bağlı)
- `key` (isteğe bağlı, gözetimsiz mod anahtarı)

Güvenlik:

- `key` olmadan, uygulama onay ister.
- Geçerli bir `key` ile çalıştırma gözetimsizdir (kişisel otomasyonlar için tasarlanmıştır).

## Onboarding akışı (tipik)

1. **OpenClaw.app**’i kurun ve başlatın.
2. İzinler kontrol listesini tamamlayın (TCC istemleri).
3. **Local** modun etkin olduğundan ve Gateway’in çalıştığından emin olun.
4. Terminal erişimi istiyorsanız CLI’yi kurun.

## Build & geliştirme iş akışı (yerel)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (veya Xcode)
- Uygulamayı paketleme: `scripts/package-mac-app.sh`

## Gateway bağlantısını hata ayıklama (macOS CLI)

Uygulamayı başlatmadan, macOS uygulamasının kullandığı Gateway WebSocket el sıkışması
ve keşif mantığının aynısını denemek için debug CLI’yi kullanın.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Bağlantı seçenekleri:

- `--url <ws://host:port>`: yapılandırmayı geçersiz kıl
- `--mode <local|remote>`: yapılandırmadan çözümle (varsayılan: yapılandırma veya yerel)
- `--probe`: yeni bir sağlık yoklaması zorla
- `--timeout <ms>`: istek zaman aşımı (varsayılan: `15000`)
- `--json`: karşılaştırma için yapılandırılmış çıktı

Keşif seçenekleri:

- `--include-local`: “yerel” olarak filtrelenecek gateway’leri dahil et
- `--timeout <ms>`: genel keşif penceresi (varsayılan: `2000`)
- `--json`: karşılaştırma için yapılandırılmış çıktı

İpucu: `openclaw gateway discover --json` ile karşılaştırarak,
macOS uygulamasının keşif hattının (NWBrowser + tailnet DNS‑SD geri dönüşü) Node CLI’nin
`dns-sd` tabanlı keşfinden farklı olup olmadığını görün.

## Uzak bağlantı tesisatı (SSH tünelleri)

macOS uygulaması **Remote** modda çalıştığında, yerel UI bileşenlerinin uzak bir
Gateway ile sanki localhost’taymış gibi konuşabilmesi için bir SSH tüneli açar.

### Denetim tüneli (Gateway WebSocket portu)

- **Amaç:** sağlık kontrolleri, durum, Web Chat, yapılandırma ve diğer kontrol düzlemi çağrıları.
- **Yerel port:** Gateway portu (varsayılan `18789`), her zaman sabit.
- **Uzak port:** uzak ana makinedeki aynı Gateway portu.
- **Davranış:** rastgele yerel port yoktur; uygulama mevcut sağlıklı bir tüneli yeniden kullanır
  veya gerekirse yeniden başlatır.
- **SSH şekli:** BatchMode +
  ExitOnForwardFailure + keepalive seçenekleriyle `ssh -N -L <local>:127.0.0.1:<remote>`.
- **IP raporlama:** SSH tüneli loopback kullanır, bu nedenle gateway düğüm IP’sini
  `127.0.0.1` olarak görür. Gerçek istemci IP’sinin görünmesini istiyorsanız
  **Direct (ws/wss)** taşımasını kullanın (bkz. [macOS remote access](/platforms/mac/remote)).

Kurulum adımları için [macOS remote access](/platforms/mac/remote) bölümüne bakın. Protokol
ayrıntıları için [Gateway protocol](/gateway/protocol) bölümüne bakın.

## İlgili belgeler

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS permissions](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
