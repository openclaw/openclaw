---
summary: "cron.add girdi işlemesini sertleştirme, şemaları hizalama ve cron UI/ajan araçlarını iyileştirme"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Cron Add Sertleştirme"
---

# Cron Add Sertleştirme ve Şema Hizalaması

## Context

Son gateway günlükleri, geçersiz parametrelerle (eksik `sessionTarget`, `wakeMode`, `payload` ve hatalı `schedule`) tekrarlanan `cron.add` hatalarını gösteriyor. Bu durum, en az bir istemcinin (muhtemelen ajan araç çağrısı yolu) sarmalanmış veya kısmen belirtilmiş iş yükleri gönderdiğini gösterir. Ayrıca TypeScript’teki cron sağlayıcı enum’ları, gateway şeması, CLI bayrakları ve UI form türleri arasında sapma bulunuyor; ayrıca `cron.status` için bir UI uyumsuzluğu var (UI `jobCount` beklerken gateway `jobs` döndürüyor).

## Hedefler

- Yaygın sarmalayıcı yükleri normalize ederek ve eksik `kind` alanlarını çıkarımla belirleyerek `cron.add` INVALID_REQUEST spam’ini durdurmak.
- Gateway şeması, cron türleri, CLI dokümanları ve UI formları genelinde cron sağlayıcı listelerini hizalamak.
- LLM’nin doğru iş yükleri üretmesi için ajan cron aracı şemasını açık hale getirmek.
- Control UI cron durum iş sayısı gösterimini düzeltmek.
- Normalizasyonu ve araç davranışını kapsayan testler eklemek.

## Hedef dışı

- Cron zamanlama semantiğini veya iş yürütme davranışını değiştirmek.
- Yeni zamanlama türleri eklemek veya cron ifade ayrıştırmasını değiştirmek.
- Gerekli alan düzeltmelerinin ötesinde cron için UI/UX’i elden geçirmek.

## Bulgular (mevcut boşluklar)

- Gateway’deki `CronPayloadSchema`, `signal` + `imessage`’yi hariç tutuyor; TS türleri ise bunları içeriyor.
- Control UI CronStatus, `jobCount` bekliyor; ancak gateway `jobs` döndürüyor.
- Ajan cron aracı şeması, keyfi `job` nesnelerine izin veriyor ve bu da hatalı girdileri mümkün kılıyor.
- Gateway, `cron.add`’yı normalizasyon olmadan katı şekilde doğruluyor; bu nedenle sarmalanmış yükler başarısız oluyor.

## Neler değişti

- `cron.add` ve `cron.update`, yaygın sarmalayıcı şekilleri normalize ediyor ve eksik `kind` alanlarını çıkarımla belirliyor.
- Ajan cron aracı şeması gateway şemasıyla eşleşiyor; bu da geçersiz yükleri azaltıyor.
- Sağlayıcı enum’ları gateway, CLI, UI ve macOS seçici genelinde hizalandı.
- Control UI, durum için gateway’in `jobs` sayım alanını kullanıyor.

## Mevcut davranış

- **Normalizasyon:** sarmalanmış `data`/`job` yükleri açılır; güvenli olduğunda `schedule.kind` ve `payload.kind` çıkarımla belirlenir.
- **Varsayılanlar:** eksik olduğunda `wakeMode` ve `sessionTarget` için güvenli varsayılanlar uygulanır.
- **Sağlayıcılar:** Discord/Slack/Signal/iMessage artık CLI/UI genelinde tutarlı biçimde sunuluyor.

Normalize edilmiş şekil ve örnekler için [Cron jobs](/automation/cron-jobs) sayfasına bakın.

## Doğrulama

- Gateway günlüklerinde azalan `cron.add` INVALID_REQUEST hatalarını izleyin.
- Yenilemeden sonra Control UI cron durumunun iş sayısını gösterdiğini doğrulayın.

## İsteğe Bağlı Takipler

- Manuel Control UI duman testi: her sağlayıcı için bir cron işi ekleyin + durum iş sayısını doğrulayın.

## Open Questions

- `cron.add`, istemcilerden açık `state` kabul etmeli mi (şu anda şema tarafından yasak)?
- `webchat`’a açık bir teslim sağlayıcısı olarak izin vermeli miyiz (şu anda teslim çözümlemesinde filtreleniyor)?
