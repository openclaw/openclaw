---
summary: "`openclaw system` için CLI referansı (sistem olayları, heartbeat, presence)"
read_when:
  - Bir cron işi oluşturmadan bir sistem olayı kuyruğa almak istediğinizde
  - Heartbeat'leri etkinleştirmeniz veya devre dışı bırakmanız gerektiğinde
  - Sistem presence girdilerini incelemek istediğinizde
title: "system"
---

# `openclaw system`

Gateway için sistem düzeyi yardımcılar: sistem olaylarını kuyruğa alma, heartbeat'leri denetleme
ve presence görüntüleme.

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

**Ana** oturumda bir sistem olayı kuyruğa alın. Bir sonraki heartbeat bunu
prompt içinde bir `System:` satırı olarak enjekte eder. Heartbeat'i
hemen tetiklemek için `--mode now` kullanın; `next-heartbeat` bir sonraki
planlı tik için bekler.

Bayraklar:

- `--text <text>`: gerekli sistem olayı metni.
- `--mode <mode>`: `now` veya `next-heartbeat` (varsayılan).
- `--json`: makine tarafından okunabilir çıktı.

## `system heartbeat last|enable|disable`

Heartbeat denetimleri:

- `last`: son heartbeat olayını gösterir.
- `enable`: heartbeat'leri yeniden açar (devre dışı bırakılmışlarsa bunu kullanın).
- `disable`: heartbeat'leri duraklatır.

Bayraklar:

- `--json`: makine tarafından okunabilir çıktı.

## `system presence`

Gateway'in bildiği mevcut sistem presence girdilerini listeler (düğümler,
örnekler ve benzeri durum satırları).

Bayraklar:

- `--json`: makine tarafından okunabilir çıktı.

## Notlar

- Geçerli yapılandırmanız (yerel veya uzak) tarafından erişilebilir, çalışan bir Gateway gerektirir.
- Sistem olayları geçicidir ve yeniden başlatmalar arasında kalıcı değildir.
