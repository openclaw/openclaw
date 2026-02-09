---
summary: "macOS’te Gateway yaşam döngüsü (launchd)"
read_when:
  - mac uygulamasını Gateway yaşam döngüsüyle entegre ederken
title: "Gateway Yaşam Döngüsü"
---

# macOS’te Gateway yaşam döngüsü

macOS uygulaması **varsayılan olarak Gateway’i launchd üzerinden yönetir** ve
Gateway’i bir alt süreç olarak başlatmaz. Önce yapılandırılmış bağlantı noktasında
zaten çalışmakta olan bir Gateway’e bağlanmayı dener; erişilebilir bir tane yoksa,
harici `openclaw` CLI aracılığıyla launchd hizmetini etkinleştirir (gömülü çalışma zamanı yoktur). Bu, oturum açıldığında güvenilir otomatik başlatma ve çökme durumlarında yeniden
başlatma sağlar.

Alt süreç modu (Gateway’in uygulama tarafından doğrudan başlatılması) bugün
**kullanımda değildir**.
UI ile daha sıkı bir bağa ihtiyacınız varsa, Gateway’i
bir terminalde manuel olarak çalıştırın.

## Varsayılan davranış (launchd)

- Uygulama, kullanıcı başına bir LaunchAgent kurar; etiketi `bot.molt.gateway`’tür
  (`--profile`/`OPENCLAW_PROFILE` kullanıldığında `bot.molt.<profile>`; eski `com.openclaw.*` desteklenir).
- Yerel mod etkinleştirildiğinde, uygulama LaunchAgent’in yüklü olmasını sağlar ve
  gerekirse Gateway’i başlatır.
- Günlükler, launchd gateway günlük yoluna yazılır (Hata Ayıklama Ayarları’nda görülebilir).

Yaygın komutlar:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Adlandırılmış bir profil çalıştırırken etiketi `bot.molt.<profile>` ile değiştirin.

## İmzalanmamış geliştirici derlemeleri

`scripts/restart-mac.sh --no-sign`, imzalama anahtarlarınız olmadığında hızlı yerel derlemeler içindir. launchd’nin imzasız bir röle ikili dosyasına işaret etmesini önlemek için şunları yapar:

- `~/.openclaw/disable-launchagent` yazar.

`scripts/restart-mac.sh`’in imzalı çalıştırmaları, işaretçi mevcutsa bu geçersiz kılmayı temizler. Manuel olarak sıfırlamak için:

```bash
rm ~/.openclaw/disable-launchagent
```

## Yalnızca ekleme modu

macOS uygulamasının **launchd’yi asla kurmaması veya yönetmemesi** için,
`--attach-only` (veya `--no-launchd`) ile başlatın. Bu, `~/.openclaw/disable-launchagent`’ü ayarlar;
böylece uygulama yalnızca halihazırda çalışan bir Gateway’e bağlanır. Aynı davranışı
Hata Ayıklama Ayarları’nda da değiştirebilirsiniz.

## Uzaktan mod

Uzak mod, yerel bir Gateway’i asla başlatmaz. Uygulama, uzak ana makineye bir SSH
tüneli kullanır ve bu tünel üzerinden bağlanır.

## Neden launchd’yi tercih ediyoruz

- Oturum açıldığında otomatik başlatma.
- Yerleşik yeniden başlatma/KeepAlive semantiği.
- Öngörülebilir günlükler ve denetim.

Gerçek bir alt süreç modu tekrar gerekirse, ayrı ve açık bir yalnızca geliştirici
modu olarak belgelenmelidir.
