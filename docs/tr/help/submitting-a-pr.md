---
summary: "Yüksek sinyalli bir PR nasıl gönderilir"
title: "PR Gönderme"
---

İyi PR’lar incelenmesi kolaydır: inceleyenler amacı hızlıca anlamalı, davranışı doğrulamalı ve değişiklikleri güvenle birleştirebilmelidir. Bu kılavuz, insan ve LLM incelemesi için özlü, yüksek sinyalli gönderimleri kapsar.

## İyi bir PR’ı ne oluşturur

- [ ] Problemi, neden önemli olduğunu ve değişikliği açıklayın.
- [ ] Değişiklikleri odaklı tutun. Geniş kapsamlı refaktörlerden kaçının.
- [ ] Kullanıcıya görünür/yapılandırma/varsayılan değişikliklerini özetleyin.
- [ ] Test kapsamını, atlananları ve nedenlerini listeleyin.
- [ ] Kanıt ekleyin: günlükler, ekran görüntüleri veya kayıtlar (UI/UX).
- [ ] Kod kelimesi: bu kılavuzu okuduysanız PR açıklamasına “lobster-biscuit” ekleyin.
- [ ] PR oluşturmadan önce ilgili `pnpm` komutlarını çalıştırın/düzeltin.
- [ ] İlgili işlevler/sorunlar/düzeltmeler için kod tabanını ve GitHub’ı arayın.
- [ ] İddiaları kanıta veya gözleme dayandırın.
- [ ] İyi başlık: fiil + kapsam + sonuç (örn., `Docs: add PR and issue templates`).

Öz olun; özlü inceleme > dilbilgisi. Uygulanmayan bölümleri çıkarın.

### Temel doğrulama komutları (değişikliğiniz için hataları çalıştırın/düzeltin)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Protokol değişiklikleri: `pnpm protocol:check`

## 46. Aşamalı açıklama

- Üst: özet/amaç
- Sonraki: değişiklikler/riskler
- Sonraki: test/doğrulama
- Son: uygulama/kanıt

## Yaygın PR türleri: ayrıntılar

- [ ] Fix: Yeniden üretim adımı, kök neden, doğrulama ekleyin.
- [ ] Feature: Kullanım senaryoları, davranış/demolar/ekran görüntüleri (UI) ekleyin.
- [ ] Refactor: “davranış değişikliği yok” ifadesini ekleyin, taşınan/sadeleştirilenleri listeleyin.
- [ ] Chore: Nedenini belirtin (örn. derleme süresi, CI, bağımlılıklar).
- [ ] Docs: Öncesi/sonrası bağlamı, güncellenen sayfa bağlantısı, `pnpm format` çalıştırın.
- [ ] Test: Hangi boşluğun kapatıldığı; regresyonları nasıl önlediği.
- [ ] Perf: Öncesi/sonrası metrikleri ve nasıl ölçüldüğü.
- [ ] UX/UI: Ekran görüntüleri/video, erişilebilirlik etkisini not edin.
- [ ] Infra/Build: Ortamlar/doğrulama.
- [ ] Security: Riski, yeniden üretimi, doğrulamayı özetleyin; hassas veri yok. Yalnızca temellendirilmiş iddialar.

## Kontrol Listesi

- [ ] Net problem/amaç
- [ ] Odaklı kapsam
- [ ] Davranış değişikliklerini listeleme
- [ ] Testlerin listesi ve sonuçları
- [ ] Manuel test adımları (uygulanabilir olduğunda)
- [ ] Gizli/özel veri yok
- [ ] Kanıta dayalı

## Genel PR Şablonu

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## PR Türü şablonları (türünüzle değiştirin)

### Fix

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Feature

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Refactor

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Chore/Maintenance

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Docs

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Test

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Infra/Build

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Security

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
