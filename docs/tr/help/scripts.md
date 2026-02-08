---
summary: "Depo betikleri: amaç, kapsam ve güvenlik notları"
read_when:
  - Depodan betik çalıştırırken
  - ./scripts altında betik eklerken veya değiştirirken
title: "Betikler"
x-i18n:
  source_path: help/scripts.md
  source_hash: efd220df28f20b33
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:15Z
---

# Betikler

`scripts/` dizini, yerel iş akışları ve operasyon görevleri için yardımcı betikleri içerir.
Bir görev açıkça bir betiğe bağlı olduğunda bunları kullanın; aksi halde CLI’yi tercih edin.

## Kurallar

- Betikler, dokümanlarda veya sürüm kontrol listelerinde referans verilmedikçe **isteğe bağlıdır**.
- Mevcut olduklarında CLI yüzeylerini tercih edin (örnek: kimlik doğrulama izleme `openclaw models status --check` kullanır).
- Betiklerin ana makineye özgü olduğunu varsayın; yeni bir makinede çalıştırmadan önce okuyun.

## Kimlik doğrulama izleme betikleri

Kimlik doğrulama izleme betikleri burada belgelenmiştir:
[/automation/auth-monitoring](/automation/auth-monitoring)

## Betik eklerken

- Betikleri odaklı ve belgeli tutun.
- İlgili dokümana kısa bir giriş ekleyin (yoksa oluşturun).
