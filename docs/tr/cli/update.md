---
summary: "`openclaw update` için CLI referansı (güvenli sayılır kaynak güncellemesi + Gateway otomatik yeniden başlatma)"
read_when:
  - Bir kaynak çalışma kopyasını güvenle güncellemek istiyorsunuz
  - "`--update` kısaltma davranışını anlamanız gerekiyor"
title: "güncelle"
---

# `openclaw update`

OpenClaw’ı güvenle güncelleyin ve stable/beta/dev kanalları arasında geçiş yapın.

**npm/pnpm** ile kurduysanız (global kurulum, git meta verisi yok), güncellemeler [Updating](/install/updating) bölümündeki paket yöneticisi akışı üzerinden yapılır.

## Kullanım

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Seçenekler

- `--no-restart`: başarılı bir güncellemeden sonra Gateway hizmetini yeniden başlatmayı atla.
- `--channel <stable|beta|dev>`: güncelleme kanalını ayarla (git + npm; yapılandırmada kalıcıdır).
- `--tag <dist-tag|version>`: yalnızca bu güncelleme için npm dist-tag veya sürümünü geçersiz kıl.
- `--json`: makine tarafından okunabilir `UpdateRunResult` JSON çıktısı yazdır.
- `--timeout <seconds>`: adım başına zaman aşımı (varsayılan 1200s).

Not: daha eski sürümler yapılandırmayı bozabileceğinden, sürüm düşürmeler onay gerektirir.

## `update status`

Etkin güncelleme kanalını + git etiketi/dalı/SHA’yı (kaynak çalışma kopyaları için) ve güncelleme uygunluğunu gösterir.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Seçenekler:

- `--json`: makine tarafından okunabilir durum JSON’u yazdır.
- `--timeout <seconds>`: denetimler için zaman aşımı (varsayılan 3s).

## `update wizard`

Bir güncelleme kanalı seçmek ve güncellemeden sonra Gateway’i yeniden başlatıp başlatmama durumunu onaylamak için etkileşimli akış
(varsayılan yeniden başlatmaktır). Bir git çalışma kopyası olmadan `dev` seçerseniz,
oluşturmayı teklif eder.

## Ne yapar

Kanalları açıkça değiştirdiğinizde (`--channel ...`), OpenClaw ayrıca
kurulum yöntemini de hizalar:

- `dev` → bir git çalışma kopyası sağlar (varsayılan: `~/openclaw`, `OPENCLAW_GIT_DIR` ile geçersiz kılınabilir),
  günceller ve global CLI’yi bu çalışma kopyasından kurar.
- `stable`/`beta` → eşleşen dist-tag kullanarak npm’den kurar.

## Git çalışma kopyası akışı

Kanallar:

- `stable`: en son beta olmayan etiketi checkout eder, ardından build + doctor çalıştırır.
- `beta`: en son `-beta` etiketini checkout eder, ardından build + doctor çalıştırır.
- `dev`: `main`’u checkout eder, ardından fetch + rebase yapar.

Yüksek seviye:

1. Temiz bir çalışma ağacı gerektirir (commit edilmemiş değişiklik yok).
2. Seçilen kanala geçer (etiket veya dal).
3. Upstream’i fetch eder (yalnızca dev).
4. Yalnızca dev: geçici bir çalışma ağacında ön uç lint + TypeScript build ön kontrolü; uç başarısız olursa, en yeni temiz build’i bulmak için en fazla 10 commit geri gider.
5. Seçilen commit üzerine rebase eder (yalnızca dev).
6. Bağımlılıkları kurar (pnpm tercih edilir; npm yedek).
7. Build eder + Control UI’yi build eder.
8. Son “güvenli güncelleme” denetimi olarak `openclaw doctor` çalıştırır.
9. Eklentileri etkin kanala senkronize eder (dev, paketlenmiş uzantıları kullanır; stable/beta npm kullanır) ve npm ile kurulmuş eklentileri günceller.

## `--update` kısaltması

`openclaw --update`, `openclaw update`’e yeniden yazılır (kabuklar ve başlatıcı betikleri için kullanışlıdır).

## Ayrıca bakınız

- `openclaw doctor` (git çalışma kopyalarında önce güncellemeyi çalıştırmayı teklif eder)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
