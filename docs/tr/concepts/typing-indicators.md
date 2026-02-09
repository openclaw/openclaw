---
summary: "OpenClaw'ın yazma göstergelerini ne zaman gösterdiği ve bunların nasıl ayarlanacağı"
read_when:
  - Yazma göstergesi davranışını veya varsayılanlarını değiştirirken
title: "Yazma Göstergeleri"
---

# Yazma göstergeleri

Yazma göstergeleri, bir çalıştırma aktifken sohbet kanalına gönderilir. Yazmanın **ne zaman** başlayacağını kontrol etmek için
`agents.defaults.typingMode`’yi ve **ne sıklıkta** yenileneceğini kontrol etmek için
`typingIntervalSeconds`’ü kullanın.

## Varsayılanlar

`agents.defaults.typingMode` **ayarlı değilse**, OpenClaw eski davranışı korur:

- **Doğrudan sohbetler**: model döngüsü başlar başlamaz yazma başlar.
- **Bahsetme içeren grup sohbetleri**: yazma hemen başlar.
- **Bahsetme içermeyen grup sohbetleri**: yazma yalnızca mesaj metni akışı başladığında başlar.
- **Heartbeat çalıştırmaları**: yazma devre dışıdır.

## Modlar

`agents.defaults.typingMode`’i aşağıdakilerden birine ayarlayın:

- `never` — asla yazma göstergesi yok.
- `instant` — çalıştırma daha sonra yalnızca sessiz yanıt belirtecini döndürse bile,
  **model döngüsü başlar başlamaz** yazmayı başlatır.
- `thinking` — **ilk akıl yürütme deltası**nda yazmayı başlatır (çalıştırma için
  `reasoningLevel: "stream"` gerektirir).
- `message` — **ilk sessiz olmayan metin deltası**nda yazmayı başlatır (\*\*
  OC_I18N_0011\*\* sessiz belirtecini yok sayar).

“Ne kadar erken tetiklendiği” sırası:
`never` → `message` → `thinking` → `instant`

## Yapılandırma

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

Oturum bazında modu veya aralığı geçersiz kılabilirsiniz:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notlar

- `message` modu, yalnızca sessiz yanıtlar için yazma göstermez (ör. çıktıyı bastırmak için kullanılan `NO_REPLY`
  belirteci).
- `thinking`, yalnızca çalıştırma akıl yürütmeyi akış halinde gönderiyorsa tetiklenir (`reasoningLevel: "stream"`).
  Model akıl yürütme deltaları üretmezse, yazma başlamaz.
- Heartbeat’ler, moddan bağımsız olarak asla yazma göstermez.
- `typingIntervalSeconds`, **yenileme aralığını** kontrol eder, başlangıç zamanını değil.
  Varsayılan 6 saniyedir.
