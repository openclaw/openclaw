---
summary: "iOS düğüm uygulaması: Gateway’e bağlanma, eşleştirme, canvas ve sorun giderme"
read_when:
  - iOS düğümünü eşleştirirken veya yeniden bağlarken
  - iOS uygulamasını kaynaktan çalıştırırken
  - Gateway keşfi veya canvas komutlarını hata ayıklarken
title: "iOS Uygulaması"
---

# iOS Uygulaması (Node)

Kullanılabilirlik: dahili ön izleme. iOS uygulaması henüz herkese açık olarak dağıtılmamaktadır.

## Ne yapar

- Bir Gateway’e WebSocket üzerinden bağlanır (LAN veya tailnet).
- Düğüm yeteneklerini sunar: Canvas, Ekran anlık görüntüsü, Kamera yakalama, Konum, Konuşma modu, Sesle uyandırma.
- `node.invoke` komutlarını alır ve düğüm durum olaylarını raporlar.

## Gereksinimler

- Başka bir cihazda çalışan Gateway (macOS, Linux veya WSL2 üzerinden Windows).
- Ağ yolu:
  - Bonjour üzerinden aynı LAN, **veya**
  - Unicast DNS-SD üzerinden Tailnet (örnek alan adı: `openclaw.internal.`), **veya**
  - Manuel ana makine/port (yedek).

## Hızlı başlangıç (eşleştir + bağlan)

1. Gateway’i başlatın:

```bash
openclaw gateway --port 18789
```

2. iOS uygulamasında Ayarlar’ı açın ve keşfedilen bir gateway’i seçin (veya Manuel Ana Makine’yi etkinleştirip ana makine/port girin).

3. Gateway ana makinesinde eşleştirme isteğini onaylayın:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Bağlantıyı doğrulayın:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Keşif yolları

### Bonjour (LAN)

Gateway, `_openclaw-gw._tcp`’i `local.` üzerinde duyurur. iOS uygulaması bunları otomatik olarak listeler.

### Tailnet (ağlar arası)

mDNS engelliyse, bir unicast DNS-SD bölgesi kullanın (bir alan adı seçin; örnek: `openclaw.internal.`) ve Tailscale split DNS yapılandırın.
CoreDNS örneği için [Bonjour](/gateway/bonjour) bölümüne bakın.

### Manuel ana makine/port

Ayarlar’da **Manuel Ana Makine**’yi etkinleştirin ve gateway ana makinesi + portu girin (varsayılan `18789`).

## Canvas + A2UI

iOS düğümü bir WKWebView canvas’ı oluşturur. Bunu sürmek için `node.invoke` kullanın:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Notlar:

- Gateway canvas ana makinesi `/__openclaw__/canvas/` ve `/__openclaw__/a2ui/` sunar.
- Bir canvas ana makinesi URL’si duyurulduğunda iOS düğümü bağlanırken A2UI’ye otomatik olarak gider.
- Yerleşik iskelete dönmek için `canvas.navigate` ve `{"url":""}` kullanın.

### Canvas eval / anlık görüntü

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Sesle uyandırma + konuşma modu

- Sesle uyandırma ve konuşma modu Ayarlar’da mevcuttur.
- iOS arka plan sesini askıya alabilir; uygulama etkin değilken ses özelliklerini en iyi çaba (best-effort) olarak değerlendirin.

## Yaygın hatalar

- `NODE_BACKGROUND_UNAVAILABLE`: iOS uygulamasını ön plana getirin (canvas/kamera/ekran komutları bunu gerektirir).
- `A2UI_HOST_NOT_CONFIGURED`: Gateway bir canvas ana makinesi URL’si duyurmadı; [Gateway yapılandırması](/gateway/configuration) bölümünde `canvasHost`’i kontrol edin.
- Eşleştirme istemi hiç görünmüyor: `openclaw nodes pending` çalıştırın ve manuel olarak onaylayın.
- Yeniden kurulumdan sonra yeniden bağlanma başarısız: Anahtarlık’taki eşleştirme belirteci temizlenmiştir; düğümü yeniden eşleştirin.

## İlgili dokümanlar

- [Eşleştirme](/gateway/pairing)
- [Keşif](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
