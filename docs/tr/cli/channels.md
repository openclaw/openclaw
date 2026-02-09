---
summary: "`openclaw channels` için CLI başvurusu (hesaplar, durum, giriş/çıkış, günlükler)"
read_when:
  - Kanal hesaplarını eklemek/kaldırmak istediğinizde (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (eklenti)/Signal/iMessage)
  - Kanal durumunu kontrol etmek veya kanal günlüklerini izlemek istediğinizde
title: "kanallar"
---

# `openclaw channels`

Gateway üzerinde sohbet kanal hesaplarını ve çalışma zamanı durumlarını yönetin.

İlgili belgeler:

- Kanal kılavuzları: [Kanallar](/channels/index)
- Gateway yapılandırması: [Yapılandırma](/gateway/configuration)

## Yaygın komutlar

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Hesap ekleme / kaldırma

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

İpucu: `openclaw channels add --help`, kanal başına bayrakları (belirteç, uygulama belirteci, signal-cli yolları vb.) gösterir.

## Giriş / çıkış (etkileşimli)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Sorun Giderme

- Genel bir yoklama için `openclaw status --deep` çalıştırın.
- Yönlendirmeli düzeltmeler için `openclaw doctor` kullanın.
- `openclaw channels list`, `Claude: HTTP 403 ... user:profile` yazdırır → kullanım anlık görüntüsü için `user:profile` kapsamı gerekir. `--no-usage` kullanın veya bir claude.ai oturum anahtarı sağlayın (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), ya da Claude Code CLI üzerinden yeniden kimlik doğrulaması yapın.

## Capabilities probe

Sağlayıcı yetenek ipuçlarını (mevcut olduğunda intent'ler/kapsamlar) ve statik özellik desteğini alın:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notlar:

- `--channel` isteğe bağlıdır; tüm kanalları (uzantılar dahil) listelemek için atlayın.
- `--target`, `channel:<id>` veya ham bir sayısal kanal kimliği kabul eder ve yalnızca Discord için geçerlidir.
- Yoklamalar sağlayıcıya özgüdür: Discord intent'leri + isteğe bağlı kanal izinleri; Slack bot + kullanıcı kapsamları; Telegram bot bayrakları + webhook; Signal daemon sürümü; MS Teams uygulama belirteci + Graph rolleri/kapsamları (bilinen yerlerde açıklamalı). Yoklaması olmayan kanallar `Probe: unavailable` bildirir.

## Adları kimliklere çözümleme

Sağlayıcı dizinini kullanarak kanal/kullanıcı adlarını kimliklere çözümleyin:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Notlar:

- Hedef türü zorlamak için `--kind user|group|auto` kullanın.
- Birden fazla giriş aynı adı paylaştığında, çözümleme etkin eşleşmeleri tercih eder.
