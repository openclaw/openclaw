---
summary: "Zalo Personal eklentisi: zca-cli ile QR giriş + mesajlaşma (eklenti kurulumu + kanal yapılandırması + CLI + araç)"
read_when:
  - OpenClaw içinde Zalo Personal (resmi olmayan) desteği istiyorsunuz
  - zalouser eklentisini yapılandırıyor veya geliştiriyorsunuz
title: "Zalo Personal Eklentisi"
---

# Zalo Personal (eklenti)

OpenClaw için Zalo Personal desteği; normal bir Zalo kullanıcı hesabını otomatikleştirmek üzere `zca-cli` kullanarak bir eklenti üzerinden sağlanır.

> **Uyarı:** Resmi olmayan otomasyon, hesabın askıya alınmasına/yasaklanmasına yol açabilir. Riski size aittir.

## Adlandırma

Kanal kimliği, bunun **kişisel bir Zalo kullanıcı hesabını** (resmi olmayan) otomatikleştirdiğini açıkça belirtmek için `zalouser`’dır. Olası gelecekteki resmi Zalo API entegrasyonu için `zalo`’yi ayrılmış tutuyoruz.

## Nerede çalışır

Bu eklenti **Gateway sürecinin içinde** çalışır.

Uzak bir Gateway kullanıyorsanız, Gateway’i çalıştıran **makineye** kurun/yapılandırın ve ardından Gateway’i yeniden başlatın.

## Yükleme

### Seçenek A: npm’den yükleme

```bash
openclaw plugins install @openclaw/zalouser
```

Ardından Gateway’i yeniden başlatın.

### Seçenek B: yerel bir klasörden yükleme (geliştirme)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Ardından Gateway’i yeniden başlatın.

## Ön koşul: zca-cli

Gateway makinesinde `zca`, `PATH` üzerinde bulunmalıdır:

```bash
zca --version
```

## Yapılandırma

Kanal yapılandırması `channels.zalouser` altında yer alır (`plugins.entries.*` değil):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Ajan aracı

Araç adı: `zalouser`

Eylemler: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
