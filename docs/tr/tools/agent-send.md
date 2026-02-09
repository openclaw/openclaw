---
summary: "Doğrudan `openclaw agent` CLI çalıştırmaları (isteğe bağlı teslimat ile)"
read_when:
  - Ajan CLI giriş noktasını eklerken veya değiştirirken
title: "Agent Send"
---

# `openclaw agent` (doğrudan ajan çalıştırmaları)

`openclaw agent`, gelen bir sohbet mesajına ihtiyaç duymadan tek bir ajan turu çalıştırır.
Varsayılan olarak **Gateway üzerinden** çalışır; mevcut makinedeki gömülü
çalışma zamanını zorlamak için `--local` ekleyin.

## Davranış

- Gerekli: `--message <text>`
- Oturum seçimi:
  - `--to <dest>` oturum anahtarını türetir (grup/kanal hedefleri izolasyonu korur; doğrudan sohbetler `main`’ya indirgenir), **veya**
  - `--session-id <id>` kimliğe göre mevcut bir oturumu yeniden kullanır, **veya**
  - `--agent <id>` yapılandırılmış bir ajanı doğrudan hedefler (o ajanın `main` oturum anahtarını kullanır)
- Normal gelen yanıtlarla aynı gömülü ajan çalışma zamanını çalıştırır.
- Düşünme/ayrıntılı bayraklar oturum deposuna kalıcı olarak yazılır.
- Çıktı:
  - varsayılan: yanıt metnini yazdırır (`MEDIA:<url>` satırlarıyla birlikte)
  - `--json`: yapılandırılmış yük + meta verileri yazdırır
- `--deliver` + `--channel` ile bir kanala isteğe bağlı geri teslimat (hedef biçimleri `openclaw message --target` ile eşleşir).
- Oturumu değiştirmeden teslimatı geçersiz kılmak için `--reply-channel`/`--reply-to`/`--reply-account` kullanın.

Gateway erişilemezse, CLI gömülü yerel çalıştırmaya **geri döner**.

## Örnekler

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Bayraklar

- `--local`: yerel olarak çalıştır (kabuk ortamınızda model sağlayıcı API anahtarları gerektirir)
- `--deliver`: yanıtı seçilen kanala gönder
- `--channel`: teslimat kanalı (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, varsayılan: `whatsapp`)
- `--reply-to`: teslimat hedefi geçersiz kılma
- `--reply-channel`: teslimat kanalı geçersiz kılma
- `--reply-account`: teslimat hesap kimliği geçersiz kılma
- `--thinking <off|minimal|low|medium|high|xhigh>`: düşünme düzeyini kalıcı yap (yalnızca GPT-5.2 + Codex modelleri)
- `--verbose <on|full|off>`: ayrıntılı düzeyi kalıcı yap
- `--timeout <seconds>`: ajan zaman aşımını geçersiz kıl
- `--json`: yapılandırılmış JSON çıktısı
