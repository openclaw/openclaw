---
summary: "`openclaw hooks` için CLI başvuru dokümantasyonu (ajan hooks)"
read_when:
  - You want to manage agent hooks
  - Hooks’ları yüklemek veya güncellemek istediğinizde
title: "hooks"
---

# `openclaw hooks`

Ajan hooks’larını yönetin ( `/new`, `/reset` gibi komutlar ve gateway başlangıcı için olay güdümlü otomasyonlar).

İlgili:

- Hooks: [Hooks](/automation/hooks)
- Eklenti hooks’ları: [Plugins](/tools/plugin#plugin-hooks)

## Tüm Hooks’ları Listeleme

```bash
openclaw hooks list
```

Çalışma alanı, yönetilen ve paketlenmiş dizinlerden keşfedilen tüm hooks’ları listeler.

**Seçenekler:**

- `--eligible`: Yalnızca uygun hooks’ları gösterir (gereksinimler karşılanmış)
- `--json`: JSON olarak çıktı verir
- `-v, --verbose`: Eksik gereksinimler dahil ayrıntılı bilgileri gösterir

**Örnek çıktı:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**Örnek (ayrıntılı):**

```bash
openclaw hooks list --verbose
```

Uygun olmayan hooks’lar için eksik gereksinimleri gösterir.

**Örnek (JSON):**

```bash
openclaw hooks list --json
```

Programatik kullanım için yapılandırılmış JSON döndürür.

## Hook Bilgilerini Alma

```bash
openclaw hooks info <name>
```

Belirli bir hook hakkında ayrıntılı bilgi gösterir.

**Argümanlar:**

- `<name>`: Hook adı (ör. `session-memory`)

**Seçenekler:**

- `--json`: JSON olarak çıktı verir

**Örnek:**

```bash
openclaw hooks info session-memory
```

**Output:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## Hooks Uygunluğunu Kontrol Etme

```bash
openclaw hooks check
```

Hook uygunluk durumunun özetini gösterir (kaçının hazır olduğu vs. hazır olmadığı).

**Seçenekler:**

- `--json`: JSON olarak çıktı verir

**Örnek çıktı:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## Bir Hook’u Etkinleştirme

```bash
openclaw hooks enable <name>
```

Belirli bir hook’u yapılandırmanıza (`~/.openclaw/config.json`) ekleyerek etkinleştirir.

**Not:** Eklentiler tarafından yönetilen hooks’lar `openclaw hooks list` içinde `plugin:<id>` olarak görünür ve
buradan etkinleştirilemez/devre dışı bırakılamaz. Bunun yerine eklentiyi etkinleştirin/devre dışı bırakın.

**Argümanlar:**

- `<name>`: Hook adı (ör. `session-memory`)

**Örnek:**

```bash
openclaw hooks enable session-memory
```

**Output:**

```
✓ Enabled hook: 💾 session-memory
```

**Ne yapar:**

- Hook’un var olup olmadığını ve uygunluğunu kontrol eder
- Yapılandırmanızdaki `hooks.internal.entries.<name>.enabled = true` alanını günceller
- Yapılandırmayı diske kaydeder

**Etkinleştirdikten sonra:**

- Hooks’ların yeniden yüklenmesi için gateway’i yeniden başlatın (macOS’ta menü çubuğu uygulamasını yeniden başlatın veya geliştirme ortamında gateway sürecini yeniden başlatın).

## Disable a Hook

```bash
openclaw hooks disable <name>
```

Yapılandırmanızı güncelleyerek belirli bir hook’u devre dışı bırakır.

**Argümanlar:**

- `<name>`: Hook adı (ör. `command-logger`)

**Örnek:**

```bash
openclaw hooks disable command-logger
```

**Output:**

```
⏸ Disabled hook: 📝 command-logger
```

**Devre dışı bıraktıktan sonra:**

- Hooks’ların yeniden yüklenmesi için gateway’i yeniden başlatın

## Hooks Yükleme

```bash
openclaw hooks install <path-or-spec>
```

Yerel bir klasörden/arşivden veya npm’den bir hook paketi yükler.

**Ne yapar:**

- Hook paketini `~/.openclaw/hooks/<id>` içine kopyalar
- Yüklenen hooks’ları `hooks.internal.entries.*` içinde etkinleştirir
- Kurulumu `hooks.internal.installs` altında kaydeder

**Seçenekler:**

- `-l, --link`: Kopyalamak yerine yerel bir dizini bağlar (`hooks.internal.load.extraDirs` içine ekler)

**Desteklenen arşivler:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Örnekler:**

```bash
# Local directory
openclaw hooks install ./my-hook-pack

# Local archive
openclaw hooks install ./my-hook-pack.zip

# NPM package
openclaw hooks install @openclaw/my-hook-pack

# Link a local directory without copying
openclaw hooks install -l ./my-hook-pack
```

## Hooks Güncelleme

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

Yüklü hook paketlerini günceller (yalnızca npm kurulumları).

**Seçenekler:**

- `--all`: İzlenen tüm hook paketlerini günceller
- `--dry-run`: Yazmadan neyin değişeceğini gösterir

## Paketlenmiş Hooks

### session-memory

`/new` verdiğinizde oturum bağlamını belleğe kaydeder.

**Etkinleştir:**

```bash
openclaw hooks enable session-memory
```

**Çıktı:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**Bkz.:** [session-memory dokümantasyonu](/automation/hooks#session-memory)

### command-logger

Tüm komut olaylarını merkezi bir denetim dosyasına kaydeder.

**Etkinleştir:**

```bash
openclaw hooks enable command-logger
```

**Çıktı:** `~/.openclaw/logs/commands.log`

**Günlükleri görüntüleme:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Bkz.:** [command-logger dokümantasyonu](/automation/hooks#command-logger)

### soul-evil

Bir temizleme penceresi sırasında veya rastgele bir olasılıkla enjekte edilen `SOUL.md` içeriğini `SOUL_EVIL.md` ile değiştirir.

**Etkinleştir:**

```bash
openclaw hooks enable soul-evil
```

**Bkz.:** [SOUL Evil Hook](/hooks/soul-evil)

### boot-md

Gateway başlatıldığında (kanallar başladıktan sonra) `BOOT.md` çalıştırır.

**Olaylar**: `gateway:startup`

**Etkinleştir**:

```bash
openclaw hooks enable boot-md
```

**Bkz.:** [boot-md dokümantasyonu](/automation/hooks#boot-md)
