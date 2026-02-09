---
summary: "Düğümler: eşleştirme, yetenekler, izinler ve canvas/kamera/ekran/sistem için CLI yardımcıları"
read_when:
  - iOS/Android düğümlerini bir gateway ile eşleştirme
  - Ajan bağlamı için düğüm canvas/kamerasını kullanma
  - Yeni düğüm komutları veya CLI yardımcıları ekleme
title: "Nodes"
---

# Nodes

Bir **düğüm**, Gateway **WebSocket**’ine (operatörlerle aynı port) `role: "node"` ile bağlanan ve `node.invoke` aracılığıyla bir komut yüzeyi (örn. `canvas.*`, `camera.*`, `system.*`) sunan bir yardımcı cihazdır (macOS/iOS/Android/headless). Protokol ayrıntıları: [Gateway protocol](/gateway/protocol).

Eski taşıma: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; kullanımdan kaldırıldı/mevcut düğümler için kaldırıldı).

macOS ayrıca **node mode**’da çalışabilir: menü çubuğu uygulaması Gateway’in WS sunucusuna bağlanır ve yerel canvas/kamera komutlarını bir düğüm olarak sunar (böylece `openclaw nodes …` bu Mac’e karşı çalışır).

Notlar:

- Düğümler **çevre birimleridir**, gateway değildir. Gateway hizmetini çalıştırmazlar.
- Telegram/WhatsApp vb. mesajlar düğümlere değil **gateway**’e ulaşır.
- Sorun giderme rehberi: [/nodes/troubleshooting](/nodes/troubleshooting)

## Eşleştirme + durum

**WS düğümleri cihaz eşleştirmesi kullanır.** Düğümler `connect` sırasında bir cihaz kimliği sunar; Gateway `role: node` için bir cihaz eşleştirme isteği oluşturur. Cihazın CLI’si (veya UI) üzerinden onaylayın.

Hızlı CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Notlar:

- `nodes status`, cihaz eşleştirme rolü `node` içerdiğinde bir düğümü **eşleşmiş** olarak işaretler.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) gateway’e ait ayrı bir
  düğüm eşleştirme deposudur; WS `connect` el sıkışmasını **engellemez**.

## Uzak düğüm ana makinesi (system.run)

Gateway’iniz bir makinede çalışırken komutların başka bir makinede yürütülmesini istiyorsanız bir **node host** kullanın. Model hâlâ **gateway** ile konuşur; `host=node` seçildiğinde gateway, `exec` çağrılarını **node host**’a iletir.

### Nerede ne çalışır

- **Gateway ana makinesi**: mesajları alır, modeli çalıştırır, araç çağrılarını yönlendirir.
- **Node host**: düğüm makinesinde `system.run`/`system.which` yürütür.
- **Onaylar**: node host üzerinde `~/.openclaw/exec-approvals.json` ile uygulanır.

### Bir node host başlatma (ön planda)

Düğüm makinesinde:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### SSH tüneli üzerinden uzak gateway (loopback bağlama)

Gateway loopback’e bağlanıyorsa (`gateway.bind=loopback`, yerel modda varsayılan),
uzak node host’lar doğrudan bağlanamaz. Bir SSH tüneli oluşturun ve node host’u
tünelin yerel ucuna yönlendirin.

Örnek (node host -> gateway ana makinesi):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Notlar:

- Belirteç, gateway yapılandırmasındaki `gateway.auth.token`’dir (gateway ana makinesinde `~/.openclaw/openclaw.json`).
- `openclaw node run`, kimlik doğrulama için `OPENCLAW_GATEWAY_TOKEN`’ü okur.

### Bir node host başlatma (servis)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Eşleştir + adlandır

Gateway ana makinesinde:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Adlandırma seçenekleri:

- `openclaw node run` / `openclaw node install` üzerinde `--display-name` (düğümde `~/.openclaw/node.json` içinde kalıcıdır).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway geçersiz kılma).

### Komutları izin listesine alma

Çalıştırma onayları **node host başına**dır. Gateway’den izin listesi girdileri ekleyin:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Onaylar node host üzerinde `~/.openclaw/exec-approvals.json` konumunda bulunur.

### Point exec at the node

Varsayılanları yapılandırın (gateway yapılandırması):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Ya da oturum başına:

```
/exec host=node security=allowlist node=<id-or-name>
```

Ayarladıktan sonra, `host=node` içeren herhangi bir `exec` çağrısı (node izin listesi/onaylarına tabi olarak)
node host üzerinde çalışır.

İlgili:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Invoking commands

Düşük seviye (ham RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Yaygın “ajana MEDYA eki ver” iş akışları için daha üst seviye yardımcılar mevcuttur.

## Ekran görüntüleri (canvas anlık görüntüler)

Düğüm Canvas’ı (WebView) gösteriyorsa, `canvas.snapshot` `{ format, base64 }` döndürür.

CLI yardımcısı (geçici bir dosyaya yazar ve `MEDIA:<path>` yazdırır):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas denetimleri

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notlar:

- `canvas present`, URL’leri veya yerel dosya yollarını (`--target`) ve konumlandırma için isteğe bağlı `--x/--y/--width/--height` kabul eder.
- `canvas eval`, satır içi JS (`--js`) veya konumsal bir argüman kabul eder.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notlar:

- Yalnızca A2UI v0.8 JSONL desteklenir (v0.9/createSurface reddedilir).

## Fotoğraflar + videolar (düğüm kamerası)

Fotoğraflar (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Video klipler (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notlar:

- `canvas.*` ve `camera.*` için düğüm **ön planda** olmalıdır (arka plan çağrıları `NODE_BACKGROUND_UNAVAILABLE` döndürür).
- Klip süresi, aşırı büyük base64 yüklerini önlemek için (şu anda `<= 60s`) sınırlandırılır.
- Android mümkün olduğunda `CAMERA`/`RECORD_AUDIO` izinleri için istem gösterir; reddedilen izinler `*_PERMISSION_REQUIRED` ile başarısız olur.

## Ekran kayıtları (düğümler)

Düğümler `screen.record` (mp4) sunar. Örnek:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notlar:

- `screen.record`, düğüm uygulamasının ön planda olmasını gerektirir.
- Android, kayıt öncesinde sistem ekran yakalama istemini gösterir.
- Ekran kayıtları `<= 60s` ile sınırlandırılır.
- `--no-audio`, mikrofon yakalamayı devre dışı bırakır (iOS/Android desteklenir; macOS sistem yakalama sesini kullanır).
- Birden fazla ekran mevcutsa bir ekran seçmek için `--screen <index>` kullanın.

## Konum (düğümler)

Düğümler, Ayarlar’da Konum etkinleştirildiğinde `location.get` sunar.

CLI yardımcısı:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notlar:

- Konum **varsayılan olarak kapalıdır**.
- “Her zaman” sistem izni gerektirir; arka plan alma en iyi çabadır.
- Yanıt; enlem/boylam, doğruluk (metre) ve zaman damgasını içerir.

## SMS (Android düğümleri)

Android düğümleri, kullanıcı **SMS** izni verdiğinde ve cihaz telefoniyi desteklediğinde `sms.send` sunabilir.

Düşük seviye çağırma:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Notlar:

- Yeteneğin ilan edilmesinden önce Android cihazda izin istemi kabul edilmelidir.
- Telefonisi olmayan yalnızca Wi‑Fi cihazlar `sms.send` ilan etmez.

## Sistem komutları (node host / mac düğümü)

macOS düğümü `system.run`, `system.notify` ve `system.execApprovals.get/set` sunar.
Headless node host `system.run`, `system.which` ve `system.execApprovals.get/set` sunar.

Örnekler:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Notlar:

- `system.run`, yükte stdout/stderr/çıkış kodunu döndürür.
- `system.notify`, macOS uygulamasındaki bildirim izin durumuna uyar.
- `system.run`, `--cwd`, `--env KEY=VAL`, `--command-timeout` ve `--needs-screen-recording` destekler.
- `system.notify`, `--priority <passive|active|timeSensitive>` ve `--delivery <system|overlay|auto>` destekler.
- macOS düğümleri `PATH` geçersiz kılmalarını yok sayar; headless node host’lar yalnızca node host PATH’ini başa eklediğinde `PATH` kabul eder.
- macOS node mode’da `system.run`, macOS uygulamasındaki çalıştırma onaylarıyla (Ayarlar → Exec approvals) kısıtlanır.
  Sor/izin listesi/tam davranışları headless node host ile aynıdır; reddedilen istemler `SYSTEM_RUN_DENIED` döndürür.
- Headless node host’ta `system.run`, çalıştırma onaylarıyla kısıtlanır (`~/.openclaw/exec-approvals.json`).

## Exec düğüm bağlama

Birden fazla düğüm mevcut olduğunda, exec’i belirli bir düğüme bağlayabilirsiniz.
Bu, `exec host=node` için varsayılan düğümü ayarlar (ajan başına geçersiz kılınabilir).

Genel varsayılan:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Herhangi bir düğüme izin vermek için kaldırın:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## İzinler haritası

Düğümler, `node.list` / `node.describe` içinde, izin adına göre anahtarlanmış (örn. `screenRecording`, `accessibility`) ve boolean değerler (`true` = verildi) içeren bir `permissions` haritası içerebilir.

## Headless node host (platformlar arası)

OpenClaw, Gateway WebSocket’ine bağlanan ve `system.run` / `system.which` sunan
bir **headless node host** (UI yok) çalıştırabilir. Bu, Linux/Windows’ta
veya bir sunucunun yanında minimal bir düğüm çalıştırmak için kullanışlıdır.

Başlatın:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Notlar:

- Eşleştirme hâlâ gereklidir (Gateway bir düğüm onay istemi gösterecektir).
- Node host; düğüm kimliğini, belirtecini, görünen adını ve gateway bağlantı bilgilerini `~/.openclaw/node.json` içinde saklar.
- Çalıştırma onayları `~/.openclaw/exec-approvals.json` aracılığıyla yerel olarak uygulanır
  ([Exec approvals](/tools/exec-approvals) bölümüne bakın).
- macOS’ta headless node host, erişilebilir olduğunda yardımcı uygulama exec host’unu tercih eder ve
  uygulama kullanılamıyorsa yerel yürütmeye geri döner. Uygulamayı zorunlu kılmak için `OPENCLAW_NODE_EXEC_HOST=app`,
  geri dönüşü devre dışı bırakmak için `OPENCLAW_NODE_EXEC_FALLBACK=0` ayarlayın.
- Gateway WS TLS kullanıyorsa `--tls` / `--tls-fingerprint` ekleyin.

## Mac node mode

- macOS menü çubuğu uygulaması, Gateway WS sunucusuna bir düğüm olarak bağlanır (böylece `openclaw nodes …` bu Mac’e karşı çalışır).
- Uzak modda, uygulama Gateway portu için bir SSH tüneli açar ve `localhost`’ya bağlanır.
