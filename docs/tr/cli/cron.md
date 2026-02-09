---
summary: "`openclaw cron` için CLI başvurusu (zamanlanmış ve arka plan işleri çalıştırma)"
read_when:
  - Zamanlanmış işler ve uyanmalar istediğinizde
  - Cron yürütmesini ve günlüklerini ayıklarken
title: "cron"
---

# `openclaw cron`

Gateway zamanlayıcısı için cron işlerini yönetin.

İlgili:

- Cron işleri: [Cron jobs](/automation/cron-jobs)

İpucu: komutların tüm yüzeyi için `openclaw cron --help` çalıştırın.

Not: izole `cron add` işleri varsayılan olarak `--announce` teslimatını kullanır. Çıktıyı
dahili tutmak için `--no-deliver` kullanın. `--deliver`, `--announce` için kullanım dışı bırakılmış bir takma ad olarak kalır.

Not: tek seferlik (`--at`) işler, varsayılan olarak başarıdan sonra silinir. Bunları korumak için `--keep-after-run` kullanın.

Not: yinelenen işler artık ardışık hatalardan sonra üstel yeniden deneme geri çekilmesi kullanır (30s → 1m → 5m → 15m → 60m), ardından bir sonraki başarılı çalışmadan sonra normal zamanlamaya döner.

## Yaygın düzenlemeler

Mesajı değiştirmeden teslimat ayarlarını güncelleyin:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

İzole bir iş için teslimatı devre dışı bırakın:

```bash
openclaw cron edit <job-id> --no-deliver
```

Belirli bir kanala duyurun:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
