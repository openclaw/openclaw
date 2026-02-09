---
summary: "`openclaw skills` (list/info/check) ve skill uygunluğu için CLI başvurusu"
read_when:
  - Hangi skill’lerin kullanılabilir ve çalışmaya hazır olduğunu görmek istiyorsunuz
  - Skill’ler için eksik ikililer/ortam değişkenleri/yapılandırmayı hata ayıklamak istiyorsunuz
title: "skills"
---

# `openclaw skills`

Skill’leri (paketlenmiş + çalışma alanı + yönetilen geçersiz kılmalar) inceleyin ve hangilerinin uygun olduğunu, hangilerinin gereksinimlerinin eksik olduğunu görün.

İlgili:

- Skills sistemi: [Skills](/tools/skills)
- Skills yapılandırması: [Skills config](/tools/skills-config)
- ClawHub kurulumları: [ClawHub](/tools/clawhub)

## Komutlar

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
