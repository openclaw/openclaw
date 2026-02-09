---
summary: "`openclaw config` için CLI başvurusu (yapılandırma değerlerini al/ayarla/kaldır)"
read_when:
  - Yapılandırmayı etkileşimli olmadan okumak veya düzenlemek istediğinizde
title: "config"
---

# `openclaw config`

Yapılandırma yardımcıları: değerleri yol üzerinden al/ayarla/kaldır. Alt komut olmadan
çalıştırıldığında yapılandırma sihirbazını açar ( `openclaw configure` ile aynı).

## Örnekler

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Yollar

Yollar nokta veya köşeli parantez gösterimini kullanır:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Belirli bir ajanı hedeflemek için ajan liste dizinini kullanın:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Değerler

Değerler mümkün olduğunda JSON5 olarak ayrıştırılır; aksi halde dizge olarak ele alınır.
JSON5 ayrıştırmasını zorunlu kılmak için `--json` kullanın.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Düzenlemelerden sonra gateway (ağ geçidi) yeniden başlatın.
