---
summary: "Küresel sesli uyandırma sözcükleri (Gateway sahipli) ve düğümler arasında nasıl senkronize edildikleri"
read_when:
  - Sesli uyandırma sözcüklerinin davranışını veya varsayılanlarını değiştirirken
  - Uyandırma sözcüğü senkronizasyonu gerektiren yeni düğüm platformları eklerken
title: "Sesli Uyandırma"
---

# Sesli Uyandırma (Küresel Uyandırma Sözcükleri)

OpenClaw, **uyandırma sözcüklerini Gateway tarafından sahip olunan tek bir küresel liste** olarak ele alır.

- There are **no per-node custom wake words**.
- **Herhangi bir düğüm/uygulama arayüzü listeyi düzenleyebilir**; değişiklikler Gateway tarafından kalıcı hale getirilir ve herkese yayınlanır.
- Her cihaz, **Sesli Uyandırma etkin/devre dışı** anahtarını ayrı ayrı tutar (yerel UX + izinler farklıdır).

## Depolama (Gateway ana makinesi)

Uyandırma sözcükleri gateway makinesinde şu konumda saklanır:

- `~/.openclaw/settings/voicewake.json`

Biçim:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protokol

### Yöntemler

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` parametrelerle `{ triggers: string[] }` → `{ triggers: string[] }`

Notlar:

- Tetikleyiciler normalize edilir (kırpılır, boşlar atılır). Boş listeler varsayılanlara geri döner.
- Güvenlik için sınırlar uygulanır (sayı/uzunluk üst sınırları).

### Olaylar

- `voicewake.changed` yükü `{ triggers: string[] }`

Kimler alır:

- Tüm WebSocket istemcileri (macOS uygulaması, WebChat vb.)
- Tüm bağlı düğümler (iOS/Android) ve ayrıca düğüm bağlanırken başlangıç “mevcut durum” iletimi olarak.

## Client behavior

### macOS uygulaması

- `VoiceWakeRuntime` tetikleyicilerini sınırlamak için küresel listeyi kullanır.
- Sesli Uyandırma ayarlarında “Tetikleyici sözcükler”i düzenlemek `voicewake.set` çağrısını yapar ve diğer istemcileri senkron tutmak için yayına güvenir.

### iOS düğümü

- `VoiceWakeManager` tetikleyici algılaması için küresel listeyi kullanır.
- Ayarlar’da Uyandırma Sözcüklerini düzenlemek `voicewake.set` çağrısını (Gateway WS üzerinden) yapar ve yerel uyandırma sözcüğü algılamasını da duyarlı tutar.

### Android düğümü

- Ayarlar’da bir Uyandırma Sözcükleri düzenleyicisi sunar.
- Düzenlemelerin her yerde senkronize olması için Gateway WS üzerinden `voicewake.set` çağrısını yapar.
