---
summary: Node + tsx "__name bir fonksiyon değil" çökme notları ve geçici çözümler
read_when:
  - Yalnızca Node’a özgü geliştirme betiklerini veya izleme modu hatalarını ayıklarken
  - OpenClaw’da tsx/esbuild yükleyici çökmelerini incelerken
title: "Node + tsx Çökmesi"
---

# Node + tsx "\_\_name bir fonksiyon değil" çökmesi

## Özet

OpenClaw’ı Node üzerinden `tsx` ile çalıştırmak başlangıçta şu hata ile başarısız olur:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Bu durum, geliştirme betiklerinin Bun’dan `tsx`’e geçirilmesinden sonra başladı (commit `2871657e`, 2026-01-06). Aynı çalışma yolu Bun ile sorunsuzdu.

## Environment

- Node: v25.x (v25.3.0 üzerinde gözlemlendi)
- tsx: 4.21.0
- OS: macOS (Node 25 çalıştıran diğer platformlarda da yeniden üretilebilir olması muhtemel)

## Repro (Node-only)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimal repro in repo

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node sürümü kontrolü

- Node 25.3.0: başarısız
- Node 22.22.0 (Homebrew `node@22`): başarısız
- Node 24: henüz burada kurulu değil; doğrulama gerekiyor

## Notlar / hipotez

- `tsx`, TS/ESM’i dönüştürmek için esbuild kullanır. esbuild’in `keepNames` özelliği bir `__name` yardımcı fonksiyonu üretir ve fonksiyon tanımlarını `__name(...)` ile sarar.
- Çökme, `__name`’nin var olduğunu ancak çalışma zamanında bir fonksiyon olmadığını gösterir; bu da Node 25 yükleyici yolunda bu modül için yardımcı fonksiyonun eksik veya üzerine yazılmış olduğunu ima eder.
- Benzer `__name` yardımcı fonksiyon sorunları, yardımcı fonksiyonun eksik veya yeniden yazıldığı durumlarda diğer esbuild kullanıcılarında rapor edilmiştir.

## Regresyon geçmişi

- `2871657e` (2026-01-06): Bun’u isteğe bağlı yapmak için betikler Bun’dan tsx’e değiştirildi.
- Bundan önce (Bun yolu), `openclaw status` ve `gateway:watch` çalışıyordu.

## Geçici çözümler

- Geliştirme betikleri için Bun kullanın (mevcut geçici geri dönüş).

- Node + tsc izleme kullanın, ardından derlenmiş çıktıyı çalıştırın:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Yerelde doğrulandı: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` Node 25’te çalışıyor.

- Mümkünse TS yükleyicisinde esbuild keepNames’i devre dışı bırakın (`__name` yardımcı fonksiyon eklenmesini engeller); tsx şu anda bunu sunmuyor.

- Sorunun Node 25’e özgü olup olmadığını görmek için `tsx` ile Node LTS (22/24) test edin.

## Kaynaklar

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Sonraki adımlar

- Node 25 regresyonunu doğrulamak için Node 22/24’te yeniden üretin.
- Bilinen bir regresyon varsa `tsx` nightly’i test edin veya daha eski bir sürüme sabitleyin.
- Node LTS’te de yeniden üretilirse, `__name` yığın izini içeren minimal bir yeniden üretimi upstream’e bildirin.
