---
summary: "`openclaw browser` için CLI referansı (profiller, sekmeler, eylemler, uzantı aktarımı)"
read_when:
  - "`openclaw browser` kullanıyor ve yaygın görevler için örnekler istiyorsunuz"
  - Başka bir makinede çalışan bir tarayıcıyı bir node ana makinesi üzerinden kontrol etmek istiyorsunuz
  - Chrome uzantı aktarımını kullanmak istiyorsunuz (araç çubuğu düğmesiyle ekle/çıkar)
title: "tarayıcı"
---

# `openclaw browser`

OpenClaw’ın tarayıcı kontrol sunucusunu yönetin ve tarayıcı eylemlerini çalıştırın (sekmeler, anlık görüntüler, ekran görüntüleri, gezinme, tıklamalar, yazma).

İlgili:

- Tarayıcı aracı + API: [Browser tool](/tools/browser)
- Chrome uzantı aktarımı: [Chrome extension](/tools/chrome-extension)

## Yaygın bayraklar

- `--url <gatewayWsUrl>`: Gateway WebSocket URL’si (varsayılan olarak yapılandırmadan).
- `--token <token>`: Gateway belirteci (gerekirse).
- `--timeout <ms>`: istek zaman aşımı (ms).
- `--browser-profile <name>`: bir tarayıcı profili seçin (yapılandırmadan varsayılan).
- `--json`: makine tarafından okunabilir çıktı (desteklendiği yerlerde).

## Hızlı başlangıç (yerel)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profiller

Profiller, adlandırılmış tarayıcı yönlendirme yapılandırmalarıdır. Pratikte:

- `openclaw`: OpenClaw tarafından yönetilen, adanmış bir Chrome örneğini başlatır/bağlanır (yalıtılmış kullanıcı verisi dizini).
- `chrome`: Chrome uzantı aktarımı üzerinden mevcut Chrome sekmelerinizi kontrol eder.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Belirli bir profil kullanın:

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Anlık görüntü / ekran görüntüsü / eylemler

Anlık görüntü:

```bash
openclaw browser snapshot
```

Ekran görüntüsü:

```bash
openclaw browser screenshot
```

Navigate/click/type (ref-based UI automation):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome uzantı aktarımı (araç çubuğu düğmesiyle ekle)

Bu mod, manuel olarak eklediğiniz mevcut bir Chrome sekmesini ajanın kontrol etmesini sağlar (otomatik ekleme yapmaz).

Paketlenmemiş uzantıyı sabit bir yola yükleyin:

```bash
openclaw browser extension install
openclaw browser extension path
```

Ardından Chrome → `chrome://extensions` → “Geliştirici modu”nu etkinleştirin → “Paketlenmemiş öğe yükle” → yazdırılan klasörü seçin.

Tam kılavuz: [Chrome extension](/tools/chrome-extension)

## Uzaktan tarayıcı kontrolü (node ana makinesi proxy’si)

Gateway tarayıcıdan farklı bir makinede çalışıyorsa, Chrome/Brave/Edge/Chromium bulunan makinede bir **node ana makinesi** çalıştırın. Gateway, tarayıcı eylemlerini bu node’a proxy’ler (ayrı bir tarayıcı kontrol sunucusu gerekmez).

Otomatik yönlendirmeyi kontrol etmek için `gateway.nodes.browser.mode`’yi ve birden fazla node bağlıysa belirli bir node’u sabitlemek için `gateway.nodes.browser.node`’i kullanın.

Güvenlik + uzaktan kurulum: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
