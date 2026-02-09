---
summary: "Model sağlayıcıları için OAuth süresinin dolmasını izleyin"
read_when:
  - Kimlik doğrulama süresi dolma izleme veya uyarıları ayarlarken
  - Claude Code / Codex OAuth yenileme denetimlerini otomatikleştirirken
title: "Kimlik Doğrulama İzleme"
---

# Kimlik doğrulama izleme

OpenClaw, OAuth süresinin dolmasına ilişkin sağlık durumunu `openclaw models status` üzerinden sunar. Bunu
otomasyon ve uyarılar için kullanın; betikler telefon iş akışları için isteğe bağlı eklerdir.

## Tercih edilen: CLI denetimi (taşınabilir)

```bash
openclaw models status --check
```

Çıkış kodları:

- `0`: OK
- `1`: süresi dolmuş veya eksik kimlik bilgileri
- `2`: yakında dolacak (24 saat içinde)

Bu, cron/systemd içinde çalışır ve ek betik gerektirmez.

## İsteğe bağlı betikler (operasyonlar / telefon iş akışları)

Bunlar `scripts/` altında yer alır ve **isteğe bağlıdır**. Gateway ana makinesine SSH erişimi varsayar ve
systemd + Termux için ayarlanmıştır.

- `scripts/claude-auth-status.sh` artık `openclaw models status --json`’yi
  tek doğru kaynak olarak kullanır (CLI kullanılamıyorsa doğrudan dosya okumaya geri döner),
  bu nedenle zamanlayıcılar için `openclaw`’yi `PATH` üzerinde güncel tutun.
- `scripts/auth-monitor.sh`: cron/systemd zamanlayıcı hedefi; uyarılar gönderir (ntfy veya telefon).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd kullanıcı zamanlayıcısı.
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw kimlik doğrulama denetleyicisi (tam/json/basit).
- `scripts/mobile-reauth.sh`: SSH üzerinden yönlendirmeli yeniden kimlik doğrulama akışı.
- `scripts/termux-quick-auth.sh`: tek dokunuşlu widget durumu + kimlik doğrulama URL’sini açma.
- `scripts/termux-auth-widget.sh`: tam yönlendirmeli widget akışı.
- `scripts/termux-sync-widget.sh`: Claude Code kimlik bilgilerini → OpenClaw ile senkronize eder.

Telefon otomasyonu veya systemd zamanlayıcılarına ihtiyacınız yoksa bu betikleri atlayın.
