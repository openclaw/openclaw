---
summary: "Yükseltilmiş exec modu ve /elevated yönergeleri"
read_when:
  - Yükseltilmiş mod varsayılanlarını, izin listelerini veya slash komutu davranışını ayarlarken
title: "Elevated Modu"
---

# Yükseltilmiş Mod (/elevated yönergeleri)

## Ne işe yarar

- `/elevated on` gateway ana makinesinde çalışır ve exec onaylarını korur (`/elevated ask` ile aynı).
- `/elevated full` gateway ana makinesinde çalışır **ve** exec’i otomatik onaylar (exec onaylarını atlar).
- `/elevated ask` gateway ana makinesinde çalışır ancak exec onaylarını korur (`/elevated on` ile aynı).
- `on`/`ask` `exec.security=full`’yi **zorlamaz**; yapılandırılmış güvenlik/sorma ilkesi geçerliliğini korur.
- Yalnızca ajan **sandboxed** olduğunda davranışı değiştirir (aksi halde exec zaten ana makinede çalışır).
- Yönerge biçimleri: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Yalnızca `on|off|ask|full` kabul edilir; diğer her şey bir ipucu döndürür ve durumu değiştirmez.

## Ne kontrol eder (ve etmez)

- **Kullanılabilirlik kapıları**: `tools.elevated` küresel temel çizgidir. `agents.list[].tools.elevated` ajan bazında yükseltilmiş modu daha da kısıtlayabilir (ikisi de izin vermelidir).
- **Oturum bazlı durum**: `/elevated on|off|ask|full` mevcut oturum anahtarı için yükseltilmiş düzeyi ayarlar.
- **Satır içi yönerge**: Bir mesajın içindeki `/elevated on|ask|full` yalnızca o mesaja uygulanır.
- **Gruplar**: Grup sohbetlerinde, yükseltilmiş yönergeler yalnızca ajan bahsedildiğinde dikkate alınır. Bahsetme gereksinimini baypas eden yalnızca komut içeren mesajlar, bahsedilmiş olarak değerlendirilir.
- **Ana makinede yürütme**: yükseltilmiş, `exec`’i gateway ana makinesine zorlar; `full` ayrıca `security=full`’yi ayarlar.
- **Onaylar**: `full` exec onaylarını atlar; `on`/`ask` izin listesi/sorma kuralları gerektirdiğinde onurlandırır.
- **Sandbox dışı ajanlar**: konum için etkisizdir; yalnızca kapılama, günlükleme ve durumu etkiler.
- **Araç ilkesi geçerlidir**: `exec` araç ilkesi tarafından reddedilirse, yükseltilmiş mod kullanılamaz.
- **`/exec`’den ayrıdır**: `/exec`, yetkili gönderenler için oturum başına varsayılanları ayarlar ve yükseltilmiş mod gerektirmez.

## Çözümleme sırası

1. Mesaj üzerindeki satır içi yönerge (yalnızca o mesaja uygulanır).
2. Oturum geçersiz kılma (yalnızca yönerge içeren bir mesaj gönderilerek ayarlanır).
3. Küresel varsayılan (yapılandırmadaki `agents.defaults.elevatedDefault`).

## Oturum varsayılanını ayarlama

- **Yalnızca** yönerge olan bir mesaj gönderin (boşluklara izin verilir), örn. `/elevated full`.
- Bir onay yanıtı gönderilir (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Yükseltilmiş erişim devre dışıysa veya gönderen onaylı izin listesinde değilse, yönerge eyleme geçirilebilir bir hatayla yanıt verir ve oturum durumunu değiştirmez.
- Mevcut yükseltilmiş düzeyi görmek için argümansız olarak `/elevated` (veya `/elevated:`) gönderin.

## Kullanılabilirlik + izin listeleri

- Özellik kapısı: `tools.elevated.enabled` (kod desteklese bile yapılandırma ile varsayılan kapalı olabilir).
- Gönderen izin listesi: `tools.elevated.allowFrom` ve sağlayıcıya özel izin listeleri (örn. `discord`, `whatsapp`).
- Ajan başına kapı: `agents.list[].tools.elevated.enabled` (isteğe bağlı; yalnızca daha fazla kısıtlayabilir).
- Ajan başına izin listesi: `agents.list[].tools.elevated.allowFrom` (isteğe bağlı; ayarlandığında gönderen **hem** küresel **hem** ajan başına izin listelerine uymalıdır).
- Discord geri dönüşü: `tools.elevated.allowFrom.discord` atlanırsa, `channels.discord.dm.allowFrom` listesi geri dönüş olarak kullanılır. Geçersiz kılmak için `tools.elevated.allowFrom.discord`’i ayarlayın (`[]` bile). Ajan başına izin listeleri geri dönüşü **kullanmaz**.
- Tüm kapıların geçmesi gerekir; aksi halde yükseltilmiş mod kullanılamaz kabul edilir.

## Günlükleme + durum

- Yükseltilmiş exec çağrıları bilgi (info) seviyesinde günlüklenir.
- Oturum durumu, yükseltilmiş modu içerir (örn. `elevated=ask`, `elevated=full`).
