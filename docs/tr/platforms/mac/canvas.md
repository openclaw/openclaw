---
summary: "WKWebView + özel URL şeması ile gömülü, ajan tarafından kontrol edilen Canvas paneli"
read_when:
  - macOS Canvas panelinin uygulanması
  - Görsel çalışma alanı için ajan denetimlerinin eklenmesi
  - WKWebView Canvas yüklemelerinin hata ayıklanması
title: "Canvas"
---

# Canvas (macOS uygulaması)

macOS uygulaması, `WKWebView` kullanarak ajan tarafından kontrol edilen bir **Canvas paneli** gömer. Bu,
HTML/CSS/JS, A2UI ve küçük etkileşimli
UI yüzeyleri için hafif bir görsel çalışma alanıdır.

## Canvas’ın konumu

Canvas durumu Application Support altında saklanır:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas paneli bu dosyaları bir **özel URL şeması** üzerinden sunar:

- `openclaw-canvas://<session>/<path>`

Örnekler:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Kökte `index.html` yoksa, uygulama **yerleşik bir iskelet sayfa** gösterir.

## Panel davranışı

- Menü çubuğunun (veya fare imlecinin) yakınında konumlanan, kenarlıksız ve yeniden boyutlandırılabilir panel.
- Oturum başına boyut/konum bilgisini hatırlar.
- Yerel canvas dosyaları değiştiğinde otomatik yeniden yükler.
- Aynı anda yalnızca bir Canvas paneli görünür (gerektiğinde oturum değiştirilir).

Canvas, Ayarlar → **Allow Canvas** bölümünden devre dışı bırakılabilir. Devre dışıyken, canvas
node komutları `CANVAS_DISABLED` döndürür.

## Ajan API yüzeyi

Canvas, **Gateway WebSocket** üzerinden sunulur; böylece ajan şunları yapabilir:

- paneli gösterme/gizleme
- bir yola veya URL’ye gitme
- JavaScript değerlendirme
- anlık görüntü yakalama

CLI örnekleri:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Notlar:

- `canvas.navigate`, **yerel canvas yollarını**, `http(s)` URL’lerini ve `file://` URL’lerini kabul eder.
- `"/"` geçirirseniz, Canvas yerel iskeleti veya `index.html`’ı gösterir.

## Canvas’ta A2UI

A2UI, Gateway canvas ana makinesi tarafından barındırılır ve Canvas paneli içinde işlenir.
Gateway bir Canvas ana makinesi duyurduğunda, macOS uygulaması ilk açılışta
A2UI ana makine sayfasına otomatik olarak gider.

Varsayılan A2UI ana makine URL’si:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI komutları (v0.8)

Canvas şu anda **A2UI v0.8** sunucu→istemci mesajlarını kabul eder:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) desteklenmez.

CLI örneği:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Hızlı duman testi:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Canvas’tan ajan çalıştırmalarını tetikleme

Canvas, derin bağlantılar aracılığıyla yeni ajan çalıştırmalarını tetikleyebilir:

- `openclaw://agent?...`

Örnek (JS içinde):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

Geçerli bir anahtar sağlanmadıkça uygulama onay ister.

## Güvenlik notları

- Canvas şeması dizin geçişini engeller; dosyalar oturum kökü altında bulunmalıdır.
- Yerel Canvas içeriği özel bir şema kullanır (local loopback sunucusu gerekmez).
- Harici `http(s)` URL’lerine yalnızca açıkça gezildiğinde izin verilir.
