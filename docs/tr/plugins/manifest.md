---
summary: "Eklenti manifesti + JSON Schema gereksinimleri (katı yapılandırma doğrulaması)"
read_when:
  - Bir OpenClaw eklentisi geliştiriyorsunuz
  - Bir eklenti yapılandırma şeması yayınlamanız veya eklenti doğrulama hatalarını ayıklamanız gerekiyor
title: "Eklenti Manifesti"
x-i18n:
  source_path: plugins/manifest.md
  source_hash: 234c7c0e77f22f5c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:35Z
---

# Eklenti manifesti (openclaw.plugin.json)

Her eklenti **zorunlu olarak** **eklenti kökünde** bir `openclaw.plugin.json` dosyası sağlamalıdır.
OpenClaw, bu manifesti eklenti kodunu **çalıştırmadan** yapılandırmayı doğrulamak için kullanır.
Eksik veya geçersiz manifestler eklenti hatası olarak değerlendirilir ve yapılandırma doğrulamasını engeller.

Eklenti sisteminin tamamı için bkz.: [Plugins](/tools/plugin).

## Gerekli alanlar

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Gerekli anahtarlar:

- `id` (string): kanonik eklenti kimliği.
- `configSchema` (object): eklenti yapılandırması için JSON Schema (satır içi).

İsteğe bağlı anahtarlar:

- `kind` (string): eklenti türü (örnek: `"memory"`).
- `channels` (array): bu eklenti tarafından kaydedilen kanal kimlikleri (örnek: `["matrix"]`).
- `providers` (array): bu eklenti tarafından kaydedilen sağlayıcı kimlikleri.
- `skills` (array): yüklenecek skill dizinleri (eklenti köküne göre göreli).
- `name` (string): eklenti için görünen ad.
- `description` (string): kısa eklenti özeti.
- `uiHints` (object): UI oluşturma için yapılandırma alanı etiketleri/yer tutucular/hassas bayraklar.
- `version` (string): eklenti sürümü (bilgilendirici).

## JSON Schema gereksinimleri

- **Her eklenti bir JSON Schema sağlamalıdır**, yapılandırma kabul etmese bile.
- Boş bir şema kabul edilebilir (örneğin, `{ "type": "object", "additionalProperties": false }`).
- Şemalar çalışma zamanında değil, yapılandırma okuma/yazma sırasında doğrulanır.

## Doğrulama davranışı

- Bilinmeyen `channels.*` anahtarları, kanal kimliği bir eklenti manifesti tarafından
  tanımlanmadıkça **hata**dır.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny` ve `plugins.slots.*`,
  **keşfedilebilir** eklenti kimliklerine başvurmalıdır. Bilinmeyen kimlikler **hata**dır.
- Bir eklenti yüklüyse ancak manifesti veya şeması bozuk ya da eksikse,
  doğrulama başarısız olur ve Doctor eklenti hatasını raporlar.
- Eklenti yapılandırması mevcut ancak eklenti **devre dışı** ise, yapılandırma korunur ve
  Doctor + günlüklerde bir **uyarı** gösterilir.

## Notlar

- Manifest, yerel dosya sistemi yüklemeleri dahil **tüm eklentiler için zorunludur**.
- Çalışma zamanı eklenti modülünü yine ayrı olarak yükler; manifest yalnızca
  keşif + doğrulama içindir.
- Eklentiniz yerel (native) modüllere bağımlıysa, derleme adımlarını ve
  paket yöneticisi izin listesi gereksinimlerini belgelendirin (örneğin, pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
