---
summary: "Kararlı, beta ve dev kanalları: anlamları, geçiş ve etiketleme"
read_when:
  - Kararlı/beta/dev arasında geçiş yapmak istiyorsunuz
  - Ön sürümleri etiketliyor veya yayımlıyorsunuz
title: "Geliştirme Kanalları"
---

# Geliştirme kanalları

Son güncelleme: 2026-01-21

OpenClaw üç güncelleme kanalı sunar:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (test altındaki derlemeler).
- **dev**: `main`’ün (git) hareketli başı. npm dist-tag: `dev` (yayımlandığında).

Derlemeleri **beta**’ya gönderir, test eder ve ardından **doğrulanmış bir derlemeyi `latest`’ya terfi ettiririz**; sürüm numarasını değiştirmeden — npm kurulumları için dist-tag’ler esas kaynaktır.

## Kanallar arasında geçiş

Git checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` en son eşleşen etiketi checkout eder (çoğu zaman aynı etikettir).
- `dev`, `main`’a geçer ve upstream üzerine rebase eder.

npm/pnpm global kurulum:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Bu, ilgili npm dist-tag (`latest`, `beta`, `dev`) üzerinden günceller.

`--channel` ile kanalı **açıkça** değiştirdiğinizde, OpenClaw ayrıca
kurulum yöntemini de hizalar:

- `dev` bir git checkout’u sağlar (varsayılan `~/openclaw`, `OPENCLAW_GIT_DIR` ile geçersiz kılınabilir),
  günceller ve global CLI’yi bu checkout’tan kurar.
- `stable`/`beta` eşleşen dist-tag’i kullanarak npm’den kurar.

İpucu: Kararlı + dev’i paralel kullanmak istiyorsanız, iki klon tutun ve gateway’inizi kararlı olana yönlendirin.

## Eklentiler ve kanallar

`openclaw update` ile kanalı değiştirdiğinizde, OpenClaw eklenti kaynaklarını da senkronize eder:

- `dev` git checkout’taki paketlenmiş eklentileri tercih eder.
- `stable` ve `beta` npm ile kurulmuş eklenti paketlerini geri yükler.

## Etiketleme için en iyi uygulamalar

- Git checkout’ların ineceği sürümleri etiketleyin (`vYYYY.M.D` veya `vYYYY.M.D-<patch>`).
- Etiketleri değişmez tutun: bir etiketi asla taşımayın veya yeniden kullanmayın.
- npm dist-tag’ler npm kurulumları için esas kaynaktır:
  - `latest` → stable
  - `beta` → aday derleme
  - `dev` → ana anlık görüntü (isteğe bağlı)

## macOS uygulaması kullanılabilirliği

Beta ve dev derlemeler **macOS uygulaması sürümü içermeyebilir**. Bu sorun değildir:

- Git etiketi ve npm dist-tag yine de yayımlanabilir.
- Sürüm notlarında veya değişiklik günlüğünde “bu beta için macOS derlemesi yok” ifadesini belirtin.
