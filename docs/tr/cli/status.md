---
summary: "`openclaw status` için CLI referansı (tanılama, yoklamalar, kullanım anlık görüntüleri)"
read_when:
  - Kanal sağlığının ve son oturum alıcılarının hızlı bir teşhisini istediğinizde
  - Hata ayıklama için yapıştırılabilir “tümü” durum çıktısı istediğinizde
title: "durum"
x-i18n:
  source_path: cli/status.md
  source_hash: 2bbf5579c48034fc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:04Z
---

# `openclaw status`

Kanallar + oturumlar için tanılama.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Notlar:

- `--deep` canlı yoklamalar çalıştırır (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- Birden fazla ajan yapılandırıldığında çıktı, ajan başına oturum depolarını içerir.
- Genel bakış, mevcut olduğunda Gateway + düğüm ana makinesi hizmeti kurulum/çalışma zamanı durumunu içerir.
- Genel bakış, güncelleme kanalını + git SHA’yı (kaynak kurulumları için) içerir.
- Güncelleme bilgileri Genel bakışta görünür; bir güncelleme mevcutsa durum, `openclaw update` çalıştırılması için bir ipucu yazdırır (bkz. [Güncelleme](/install/updating)).
