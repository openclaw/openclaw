---
summary: "Kanal bağlantısı için sağlık denetimi adımları"
read_when:
  - WhatsApp kanal sağlığını teşhis ederken
title: "Sağlık Denetimleri"
---

# Sağlık Denetimleri (CLI)

Tahmin yürütmeden kanal bağlantısını doğrulamak için kısa kılavuz.

## Hızlı kontroller

- `openclaw status` — yerel özet: gateway erişilebilirliği/modu, güncelleme ipucu, bağlı kanal kimlik doğrulama yaşı, oturumlar + son etkinlik.
- `openclaw status --all` — tam yerel teşhis (salt okunur, renkli, hata ayıklama için yapıştırmaya güvenli).
- `openclaw status --deep` — ayrıca çalışan Gateway’i yoklar (desteklendiğinde kanal başına yoklamalar).
- `openclaw health --json` — çalışan Gateway’den tam bir sağlık anlık görüntüsü ister (yalnızca WS; doğrudan Baileys soketi yok).
- WhatsApp/WebChat’te bağımsız bir mesaj olarak `/status` gönderin; ajanı çağırmadan durum yanıtı alırsınız.
- Günlükler: `/tmp/openclaw/openclaw-*.log` ile takip edin ve `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound` için filtreleyin.

## Derin tanılama

- Diskte kimlik bilgileri: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime yakın zamanda olmalıdır).
- Oturum deposu: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (yol yapılandırmada geçersiz kılınabilir). Sayı ve son alıcılar `status` üzerinden gösterilir.
- Yeniden bağlama akışı: günlüklerde 409–515 durum kodları veya `loggedOut` göründüğünde `openclaw channels logout && openclaw channels login --verbose`. (Not: QR ile giriş akışı, eşleştirmeden sonra 515 durumu için bir kez otomatik yeniden başlatılır.)

## Bir şeyler başarısız olduğunda

- `logged out` veya 409–515 durumu → `openclaw channels logout` ardından `openclaw channels login` ile yeniden bağlayın.
- Gateway erişilemiyor → başlatın: `openclaw gateway --port 18789` (port meşgulse `--force` kullanın).
- Gelen mesaj yok → bağlı telefonun çevrimiçi olduğunu ve gönderenin izinli olduğunu doğrulayın (`channels.whatsapp.allowFrom`); grup sohbetleri için izin listesi + bahsetme kurallarının uyduğundan emin olun (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Özel "health" komutu

`openclaw health --json`, çalışan Gateway’den sağlık anlık görüntüsünü ister (CLI’dan doğrudan kanal soketleri yok). Mevcut olduğunda bağlı kimlik bilgileri/kimlik doğrulama yaşı, kanal başına yoklama özetleri, oturum deposu özeti ve yoklama süresini raporlar. Gateway erişilemiyorsa veya yoklama başarısız/ zaman aşımına uğrarsa sıfır olmayan bir kodla çıkar. Varsayılan 10 saniyeyi geçersiz kılmak için `--timeout <ms>` kullanın.
