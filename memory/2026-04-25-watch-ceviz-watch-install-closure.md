# 2026-04-25 - Watch Ceviz watch install closure

## Kapanış özeti

- `watch-ceviz` Apple Watch companion kurulum problemi bu turda uygulama kodu/runtime tarafından değil, CI artifact kalitesi ve signing eksikliği tarafından izole edildi.
- `watch-ceviz/project.yml` içinde companion metadata hizalandı, shared version/build (`1.1` / `2`) verildi, watch target için explicit plist yaklaşımına geçildi.
- Yeni explicit dosya eklendi: `watch-ceviz/apple-watch/Info.plist`
- Bu plist ile aşağıdakiler doğrulandı:
  - `CFBundleIdentifier = com.openclaw.ceviz.watchkitapp`
  - `WKCompanionAppBundleIdentifier = com.openclaw.ceviz`
  - `WKRunsIndependently = false`
  - `CFBundleShortVersionString = 1.1`
  - `CFBundleVersion = 2`

## CI tarafında netleşen teknik sonuç

- `build/CevizBridge.app/Watch/CevizWatchApp.app` mevcut, yani watch bundle embed ediliyor.
- Önceki belirsizliklerden biri olan `WKRunsIndependently` eksikliği explicit plist ile giderildi; sonraki run’da plist summary doğru geldi.
- Son belirleyici CI hatası:
  - `ERROR: Watch companion app has no _CodeSignature. This build is not watch-installable.`
- Dolayısıyla kök neden yüksek güvenle:
  - unsigned / export edilmemiş watch companion output
  - mevcut workflow gerçek `archive/exportArchive` + signing üretmiyor

## İlgili commitler

- `cb1d2eb` `ci(watch): fail fast on unsigned companion output`
- `36a1c87` `fix(watch): use explicit watch plist metadata`

## Sonuç cümlesi

- Bu issue için mevcut sınırlar içinde yeterli teşhis alındı.
- Apple Developer hesabı / signing materyalleri olmadan daha fazla repo yaması büyük ihtimalle aynı duvara çarpacak.
- Sonraki devam koşulu: Apple Developer hesabı alındıktan sonra signing/export pipeline kurulumu.

## Devam edildiğinde ilk iş

1. Apple Developer Program erişimi hazır mı doğrula.
2. Team ID, signing certificate, provisioning profile imkanlarını netleştir.
3. CI workflow’u `xcodebuild archive` + `xcodebuild -exportArchive` + gerçek signing secrets ile yeniden kur.
4. Yeni signed artifact ile iPhone + Watch kurulum denemesi yap.
