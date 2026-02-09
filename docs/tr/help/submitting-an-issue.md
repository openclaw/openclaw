---
summary: "Yüksek sinyal içeren sorun ve hata raporları oluşturma"
title: "Bir Sorun Gönderme"
---

## Bir Sorun Gönderme

Açık ve öz sorunlar, teşhis ve düzeltmeleri hızlandırır. Hatalar, gerilemeler veya özellik boşlukları için aşağıdakileri ekleyin:

### Neleri dahil etmeli

- [ ] Başlık: alan & belirti
- [ ] 47. Asgari yeniden üretim adımları
- [ ] Beklenen ile gerçekleşen
- [ ] 48. Etki ve ciddiyet
- [ ] Ortam: OS, çalışma zamanı, sürümler, yapılandırma
- [ ] 49. Kanıt: sansürlenmiş günlükler, ekran görüntüleri (PII içermeyen)
- [ ] Kapsam: yeni, gerileme veya uzun süredir var olan
- [ ] Kod sözcüğü: sorununuzda lobster-biscuit
- [ ] Mevcut sorunlar için kod tabanı ve GitHub’da arama yapıldı
- [ ] Yakın zamanda düzeltilmediği/ele alınmadığı doğrulandı (özellikle güvenlik)
- [ ] İddialar kanıt veya yeniden üretim ile desteklendi

Kısa olun. Kısalık > kusursuz dilbilgisi.

Doğrulama (PR’den önce çalıştırın/düzeltin):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Protokol kodu varsa: `pnpm protocol:check`

### Şablonlar

#### Hata raporu

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### Güvenlik sorunu

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Gizli bilgileri/sömürü ayrıntılarını herkese açıkta paylaşmaktan kaçının. Hassas konular için ayrıntıyı en aza indirin ve özel ifşa talep edin._

#### Gerileme raporu

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### Özellik isteği

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### İyileştirme

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### İnceleme

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Düzeltme PR’ı gönderme

PR’den önce sorun açmak isteğe bağlıdır. Atlanıyorsa ayrıntıları PR’da ekleyin. PR’ı odaklı tutun, sorun numarasını belirtin, test ekleyin veya neden olmadığını açıklayın, davranış değişikliklerini/riski belgeleyin, kanıt olarak maskelenmiş günlükler/ekran görüntüleri ekleyin ve göndermeden önce uygun doğrulamayı çalıştırın.
