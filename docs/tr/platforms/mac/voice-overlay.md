---
summary: "Uyandırma sözcüğü ve bas-konuş çakıştığında sesli yer paylaşımının yaşam döngüsü"
read_when:
  - Ses kaplama davranışını ayarlama
title: "Ses Kaplaması"
---

# Sesli Yer Paylaşımı Yaşam Döngüsü (macOS)

Hedef kitle: macOS uygulaması katkıda bulunanlar. Amaç: uyandırma sözcüğü ve bas-konuş çakıştığında sesli yer paylaşımını öngörülebilir tutmak.

## Mevcut amaç

- Yer paylaşımı zaten uyandırma sözcüğü nedeniyle görünür durumdaysa ve kullanıcı kısayol tuşuna basarsa, kısayol oturumu metni sıfırlamak yerine mevcut metni _devralır_. Kısayol basılı tutulduğu sürece yer paylaşımı açık kalır. Kullanıcı bıraktığında: kırpılmış metin varsa gönder, yoksa kapat.
- Yalnızca uyandırma sözcüğü, sessizlikte otomatik gönderim yapmaya devam eder; bas-konuş bırakıldığında hemen gönderir.

## Uygulananlar (9 Aralık 2025)

- Yer paylaşımı oturumları artık her yakalama için (uyandırma sözcüğü veya bas-konuş) bir belirteç taşır. Belirteç eşleşmediğinde kısmi/nihai/gönder/kapat/seviye güncellemeleri düşürülür; böylece bayat geri çağırmalar önlenir.
- Bas-konuş, görünür olan herhangi bir yer paylaşımı metnini önek olarak devralır (yani uyandırma yer paylaşımı açıkken kısayola basmak metni korur ve yeni konuşmayı ekler). Nihai döküm için 1,5 sn’ye kadar bekler; ardından mevcut metne geri döner.
- Zil/yer paylaşımı günlükleri `info`’de, `voicewake.overlay`, `voicewake.ptt` ve `voicewake.chime` kategorilerinde üretilir (oturum başlangıcı, kısmi, nihai, gönder, kapat, zil nedeni).

## Sonraki adımlar

1. **VoiceSessionCoordinator (actor)**
   - Aynı anda tam olarak bir `VoiceSession`’e sahiptir.
   - API (belirteç tabanlı): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Bayat belirteçler taşıyan geri çağırmaları düşürür (eski tanıyıcıların yer paylaşımını yeniden açmasını önler).
2. **VoiceSession (model)**
   - Alanlar: `token`, `source` (wakeWord|pushToTalk), commit edilmiş/geçici metin, zil bayrakları, zamanlayıcılar (otomatik gönderim, boşta), `overlayMode` (display|editing|sending), soğuma süresi son tarihi.
3. **Yer paylaşımı bağlama**
   - `VoiceSessionPublisher` (`ObservableObject`) etkin oturumu SwiftUI’ya yansıtır.
   - `VoiceWakeOverlayView` yalnızca yayınlayıcı üzerinden render eder; küresel singleton’ları doğrudan asla değiştirmez.
   - Yer paylaşımı kullanıcı eylemleri (`sendNow`, `dismiss`, `edit`) oturum belirteciyle koordinatöre geri çağrı yapar.
4. **Birleşik gönderim yolu**
   - `endCapture` sırasında: kırpılmış metin boşsa → kapat; aksi halde `performSend(session:)` (gönderim zilini bir kez çalar, iletir, kapatır).
   - Bas-konuş: gecikme yok; uyandırma sözcüğü: otomatik gönderim için isteğe bağlı gecikme.
   - Bas-konuş bittiğinde uyandırma çalışma zamanına kısa bir soğuma süresi uygula; böylece uyandırma sözcüğü hemen yeniden tetiklenmez.
5. **Günlükleme**
   - Koordinatör, `bot.molt` alt sisteminde, `voicewake.overlay` ve `voicewake.chime` kategorilerinde `.info` günlüklerini üretir.
   - Ana olaylar: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Hata ayıklama kontrol listesi

- Takılı kalan bir kaplamayı yeniden üretirken günlükleri akış halinde izleyin:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Yalnızca bir etkin oturum belirteci olduğunu doğrulayın; bayat geri çağırmalar koordinatör tarafından düşürülmelidir.

- Bas-konuş bırakma işleminin her zaman etkin belirteçle `endCapture`’i çağırdığından emin olun; metin boşsa zil veya gönderim olmadan `dismiss` bekleyin.

## Geçiş adımları (önerilen)

1. `VoiceSessionCoordinator`, `VoiceSession` ve `VoiceSessionPublisher` ekleyin.
2. `VoiceWakeRuntime`’ı, `VoiceWakeOverlayController`’e doğrudan dokunmak yerine oturumları oluşturacak/güncelleyecek/sonlandıracak şekilde yeniden düzenleyin.
3. `VoicePushToTalk`’yi mevcut oturumları devralacak ve bırakma sırasında `endCapture`’ü çağıracak şekilde yeniden düzenleyin; çalışma zamanı soğuma süresini uygulayın.
4. `VoiceWakeOverlayController`’ü yayınlayıcıya bağlayın; çalışma zamanı/PTT’den gelen doğrudan çağrıları kaldırın.
5. Oturum devralma, soğuma süresi ve boş metin kapatma için entegrasyon testleri ekleyin.
