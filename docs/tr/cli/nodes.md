---
summary: "`openclaw nodes` için CLI başvurusu (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - Eşleştirilmiş düğümleri (kameralar, ekran, tuval) yönetiyorsunuz
  - İstekleri onaylamanız veya düğüm komutlarını çağırmanız gerekiyor
title: "nodes"
---

# `openclaw nodes`

Eşleştirilmiş düğümleri (cihazları) yönetin ve düğüm yeteneklerini çağırın.

İlgili:

- Düğümler genel bakış: [Nodes](/nodes)
- Kamera: [Camera nodes](/nodes/camera)
- Görseller: [Image nodes](/nodes/images)

Yaygın seçenekler:

- `--url`, `--token`, `--timeout`, `--json`

## Yaygın komutlar

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list`, bekleyen/eşleştirilmiş tabloları yazdırır. Eşleştirilmiş satırlar en son bağlantı süresini (Last Connect) içerir.
Yalnızca şu anda bağlı olan düğümleri göstermek için `--connected` kullanın. `--last-connected <duration>` kullanarak
belirli bir süre içinde bağlanan düğümlere filtreleyin (ör. `24h`, `7d`).

## Çağır / çalıştır

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Çağırma bayrakları:

- `--params <json>`: JSON nesnesi dizesi (varsayılan `{}`).
- `--invoke-timeout <ms>`: düğüm çağırma zaman aşımı (varsayılan `15000`).
- `--idempotency-key <key>`: isteğe bağlı idempotency anahtarı.

### Exec tarzı varsayılanlar

`nodes run`, modelin exec davranışını (varsayılanlar + onaylar) yansıtır:

- `tools.exec.*` (artı `agents.list[].tools.exec.*` geçersiz kılmaları) okur.
- `system.run` çağrılmadan önce exec onaylarını (`exec.approval.request`) kullanır.
- `tools.exec.node` ayarlandığında `--node` atlanabilir.
- `system.run` duyurusu yapan bir düğüm gerektirir (macOS yardımcı uygulaması veya başsız düğüm ana makinesi).

Bayraklar:

- `--cwd <path>`: çalışma dizini.
- `--env <key=val>`: ortam değişkeni geçersiz kılma (tekrarlanabilir).
- `--command-timeout <ms>`: komut zaman aşımı.
- `--invoke-timeout <ms>`: düğüm çağırma zaman aşımı (varsayılan `30000`).
- `--needs-screen-recording`: ekran kaydı izni gerektir.
- `--raw <command>`: bir kabuk dizesi çalıştır (`/bin/sh -lc` veya `cmd.exe /c`).
- `--agent <id>`: ajan kapsamlı onaylar/izin listeleri (yapılandırılmış ajanı varsayar).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: geçersiz kılmalar.
