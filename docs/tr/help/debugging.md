---
summary: "Hata ayıklama araçları: izleme modu, ham model akışları ve muhakeme sızıntısının izlenmesi"
read_when:
  - Ham model çıktısını muhakeme sızıntısı açısından incelemeniz gerekiyor
  - Yineleme yaparken Gateway’i izleme modunda çalıştırmak istiyorsunuz
  - Tekrarlanabilir bir hata ayıklama iş akışına ihtiyacınız var
title: "Hata ayıklama"
---

# Hata ayıklama

Bu sayfa, özellikle bir sağlayıcı muhakemeyi normal metne karıştırdığında,
akış çıktısını incelemek için hata ayıklama yardımcılarını kapsar.

## Çalışma zamanı hata ayıklama geçersiz kılmaları

Sohbette **çalışma zamanı‑yalnızca** yapılandırma geçersiz kılmaları (disk değil, bellek) ayarlamak için `/debug` kullanın.
`/debug` varsayılan olarak devre dışıdır; `commands.debug: true` ile etkinleştirin.
Bu, `openclaw.json` dosyasını düzenlemeden nadiren kullanılan ayarları açıp kapatmanız gerektiğinde kullanışlıdır.

Örnekler:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` tüm geçersiz kılmaları temizler ve disk üzerindeki yapılandırmaya döner.

## Gateway izleme modu

Hızlı yineleme için gateway’i dosya izleyici altında çalıştırın:

```bash
pnpm gateway:watch --force
```

Bu şuna eşlenir:

```bash
tsx watch src/entry.ts gateway --force
```

`gateway:watch` sonrasına herhangi bir gateway CLI bayrağı ekleyin; her yeniden başlatmada iletilirler.

## Geliştirici profili + geliştirici gateway (--dev)

Hata ayıklama için durumu izole etmek ve güvenli, geçici bir kurulum başlatmak üzere geliştirici profilini kullanın. **İki** adet `--dev` bayrağı vardır:

- **Genel `--dev` (profil):** durumu `~/.openclaw-dev` altında izole eder ve
  gateway portunu varsayılan olarak `19001` yapar (türetilmiş portlar buna göre kayar).
- **`gateway --dev`: eksik olduğunda varsayılan bir yapılandırma +
  çalışma alanını otomatik oluşturması için Gateway’e talimat verir** (ve BOOTSTRAP.md’yi atlar).

Önerilen akış (geliştirici profili + geliştirici önyükleme):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Henüz genel bir kurulumunuz yoksa, CLI’yi `pnpm openclaw ...` üzerinden çalıştırın.

Bunun yaptığı:

1. **Profil izolasyonu** (genel `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (tarayıcı/tuval buna göre kayar)

2. **Geliştirici önyükleme** (`gateway --dev`)
   - Eksikse minimal bir yapılandırma yazar (`gateway.mode=local`, local loopback’e bağlanır).
   - `agent.workspace` değerini geliştirici çalışma alanına ayarlar.
   - `agent.skipBootstrap=true` ayarlanır (BOOTSTRAP.md yok).
   - Eksikse çalışma alanı dosyalarını tohumlar:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Varsayılan kimlik: **C3‑PO** (protokol droid’i).
   - Geliştirici modunda kanal sağlayıcılarını atlar (`OPENCLAW_SKIP_CHANNELS=1`).

Sıfırlama akışı (temiz başlangıç):

```bash
pnpm gateway:dev:reset
```

Not: `--dev` **genel** bir profil bayrağıdır ve bazı çalıştırıcılar tarafından yutulabilir.
Açıkça belirtmeniz gerekiyorsa, ortam değişkeni biçimini kullanın:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset`, yapılandırmayı, kimlik bilgilerini, oturumları ve geliştirici çalışma alanını siler ( `rm` değil, `trash` kullanılarak ) ve ardından varsayılan geliştirici kurulumunu yeniden oluşturur.

İpucu: geliştirici olmayan bir gateway zaten çalışıyorsa (launchd/systemd), önce durdurun:

```bash
openclaw gateway stop
```

## Ham akış günlüğü (OpenClaw)

OpenClaw, herhangi bir filtreleme/biçimlendirme uygulanmadan önce **ham yardımcı akışını** kaydedebilir.
Bu, muhakemenin düz metin deltaları olarak mı
(yoksa ayrı düşünme blokları olarak mı) geldiğini görmek için en iyi yoldur.

CLI ile etkinleştirin:

```bash
pnpm gateway:watch --force --raw-stream
```

İsteğe bağlı yol geçersiz kılma:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Eşdeğer ortam değişkenleri:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Varsayılan dosya:

`~/.openclaw/logs/raw-stream.jsonl`

## Ham parça günlüğü (pi-mono)

Bloklara ayrıştırılmadan önce **ham OpenAI‑uyumlu parçaları** yakalamak için,
pi-mono ayrı bir günlükleyici sunar:

```bash
PI_RAW_STREAM=1
```

İsteğe bağlı yol:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Varsayılan dosya:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Not: bu yalnızca pi-mono’nun
> `openai-completions` sağlayıcısını kullanan süreçler tarafından üretilir.

## Güvenlik notları

- Ham akış günlükleri tam istemleri, araç çıktısını ve kullanıcı verilerini içerebilir.
- Günlükleri yerel tutun ve hata ayıklamadan sonra silin.
- Günlükleri paylaşırsanız, önce sırları ve PII'yi temizleyin.
