---
summary: "Paketleme betikleri tarafından üretilen macOS debug derlemeleri için imzalama adımları"
read_when:
  - mac debug derlemelerini oluştururken veya imzalarken
title: "macOS İmzalama"
---

# mac imzalama (debug derlemeler)

Bu uygulama genellikle [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) üzerinden oluşturulur; bu betik artık:

- kararlı bir debug paket tanımlayıcısı ayarlar: `ai.openclaw.mac.debug`
- Info.plist’i bu paket kimliğiyle yazar ( `BUNDLE_ID=...` ile geçersiz kılınabilir)
- ana ikiliyi ve uygulama paketini imzalamak için [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) çağırır; böylece macOS her yeniden derlemeyi aynı imzalı paket olarak ele alır ve TCC izinlerini (bildirimler, erişilebilirlik, ekran kaydı, mikrofon, konuşma) korur. Kararlı izinler için gerçek bir imzalama kimliği kullanın; ad-hoc isteğe bağlıdır ve kırılgandır (bkz. [macOS permissions](/platforms/mac/permissions)).
- varsayılan olarak `CODESIGN_TIMESTAMP=auto` kullanır; bu, Developer ID imzaları için güvenilir zaman damgalarını etkinleştirir. Zaman damgalamayı atlamak (çevrimdışı debug derlemeleri) için `CODESIGN_TIMESTAMP=off` ayarlayın.
- Info.plist’e derleme meta verilerini enjekte eder: `OpenClawBuildTimestamp` (UTC) ve `OpenClawGitCommit` (kısa hash); böylece Hakkında bölmesi derleme, git ve debug/release kanalını gösterebilir.
- **Paketleme Node 22+ gerektirir**: betik TS derlemelerini ve Control UI derlemesini çalıştırır.
- ortamdan `SIGN_IDENTITY` okur. Sertifikanızla her zaman imzalamak için kabuk rc’nize `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (veya Developer ID Application sertifikanız) ekleyin. Ad-hoc imzalama, `ALLOW_ADHOC_SIGNING=1` veya `SIGN_IDENTITY="-"` üzerinden açıkça etkinleştirilmelidir (izin testleri için önerilmez).
- imzalamadan sonra bir Team ID denetimi çalıştırır ve uygulama paketi içindeki herhangi bir Mach-O farklı bir Team ID ile imzalanmışsa başarısız olur. Atlamak için `SKIP_TEAM_ID_CHECK=1` ayarlayın.

## Kullanım

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Ad-hoc İmzalama Notu

`SIGN_IDENTITY="-"` (ad-hoc) ile imzalanırken, betik **Hardened Runtime**’ı (`--options runtime`) otomatik olarak devre dışı bırakır. Bu, uygulama aynı Team ID’yi paylaşmayan gömülü framework’leri (ör. Sparkle) yüklemeye çalıştığında oluşabilecek çökmeleri önlemek için gereklidir. Ad-hoc imzalar ayrıca TCC izinlerinin kalıcılığını bozar; kurtarma adımları için [macOS permissions](/platforms/mac/permissions) sayfasına bakın.

## Hakkında için derleme meta verileri

`package-mac-app.sh` paketi şu bilgilerle damgalar:

- `OpenClawBuildTimestamp`: paketleme anında ISO8601 UTC
- `OpenClawGitCommit`: kısa git hash’i (mevcut değilse `unknown`)

Hakkında sekmesi, sürüm, derleme tarihi, git commit’i ve bunun bir debug derlemesi olup olmadığı bilgisini (`#if DEBUG` aracılığıyla) göstermek için bu anahtarları okur. Kod değişikliklerinden sonra bu değerleri yenilemek için paketleyiciyi çalıştırın.

## Neden

TCC izinleri paket tanımlayıcısına _ve_ kod imzasına bağlıdır. UUID’leri değişen imzasız debug derlemeleri, macOS’in her yeniden derlemeden sonra verilen izinleri unutmasına neden oluyordu. İkili dosyaları imzalamak (varsayılan olarak ad‑hoc) ve sabit bir paket kimliği/yolu (`dist/OpenClaw.app`) korumak, derlemeler arasında izinleri muhafaza eder; VibeTunnel yaklaşımıyla uyumludur.
