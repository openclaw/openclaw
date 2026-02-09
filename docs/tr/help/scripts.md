---
summary: "Depo betikleri: amaç, kapsam ve güvenlik notları"
read_when:
  - 39. Depodan betik çalıştırma
  - ./scripts altında betik eklerken veya değiştirirken
title: "40. Betikler"
---

# 41. Betikler

`scripts/` dizini, yerel iş akışları ve operasyon görevleri için yardımcı betikleri içerir.
Bir görev açıkça bir betiğe bağlı olduğunda bunları kullanın; aksi halde CLI’yi tercih edin.

## 42. Kurallar

- Betikler, dokümanlarda veya sürüm kontrol listelerinde referans verilmedikçe **isteğe bağlıdır**.
- Mevcut olduklarında CLI yüzeylerini tercih edin (örnek: kimlik doğrulama izleme `openclaw models status --check` kullanır).
- Betiklerin ana makineye özgü olduğunu varsayın; yeni bir makinede çalıştırmadan önce okuyun.

## 43. Kimlik doğrulama izleme betikleri

Kimlik doğrulama izleme betikleri burada belgelenmiştir:
[/automation/auth-monitoring](/automation/auth-monitoring)

## 44. Betik eklerken

- 45. Betikleri odaklı ve belgelenmiş tutun.
- İlgili dokümana kısa bir giriş ekleyin (yoksa oluşturun).
