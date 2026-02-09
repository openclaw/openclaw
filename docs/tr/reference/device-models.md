---
summary: "OpenClaw’un macOS uygulamasında Apple aygıt model tanımlayıcılarını kullanıcı dostu adlara nasıl sağladığı."
read_when:
  - Aygıt model tanımlayıcı eşlemelerini veya NOTICE/lisans dosyalarını güncellerken
  - Instances UI’nin aygıt adlarını nasıl görüntülediğini değiştirirken
title: "Aygıt Modeli Veritabanı"
---

# Aygıt modeli veritabanı (kullanıcı dostu adlar)

macOS yardımcı uygulaması, **Instances** UI’de Apple model tanımlayıcılarını (ör. `iPad16,6`, `Mac16,6`) insan tarafından okunabilir adlara eşleyerek kullanıcı dostu Apple aygıt modeli adlarını gösterir.

Eşleme, JSON olarak aşağıdaki konumda vendorludur:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Veri kaynağı

Şu anda eşlemeyi MIT lisanslı depodan vendorluyoruz:

- `kyle-seongwoo-jun/apple-device-identifiers`

Derlemeleri deterministik tutmak için, JSON dosyaları belirli upstream commit’lere sabitlenmiştir (`apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` içinde kaydedilir).

## Veritabanını güncelleme

1. Sabitlemek istediğiniz upstream commit’leri seçin (iOS için bir tane, macOS için bir tane).
2. Commit hash’lerini `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` içinde güncelleyin.
3. Bu commit’lere sabitlenmiş olarak JSON dosyalarını yeniden indirin:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` dosyasının upstream ile hâlâ eşleştiğinden emin olun (upstream lisansı değişirse değiştirin).
5. macOS uygulamasının temiz şekilde derlendiğini doğrulayın (uyarı yok):

```bash
swift build --package-path apps/macos
```
