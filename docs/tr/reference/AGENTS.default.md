---
summary: "Kişisel asistan kurulumu için varsayılan OpenClaw ajan talimatları ve Skills listesi"
read_when:
  - Yeni bir OpenClaw ajan oturumu başlatırken
  - Varsayılan Skills’i etkinleştirirken veya denetlerken
---

# AGENTS.md — OpenClaw Kişisel Asistan (varsayılan)

## İlk çalıştırma (önerilir)

OpenClaw, ajan için ayrılmış bir çalışma alanı dizini kullanır. Varsayılan: `~/.openclaw/workspace` (`agents.defaults.workspace` ile yapılandırılabilir).

1. Çalışma alanını oluşturun (henüz yoksa):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Varsayılan çalışma alanı şablonlarını çalışma alanına kopyalayın:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. İsteğe bağlı: kişisel asistan Skills listesi istiyorsanız, AGENTS.md dosyasını bu dosya ile değiştirin:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. İsteğe bağlı: `agents.defaults.workspace` ayarlayarak farklı bir çalışma alanı seçin (`~` desteklenir):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Güvenlik varsayılanları

- Dizinleri veya gizli bilgileri sohbete dökmeyin.
- Açıkça istenmedikçe yıkıcı komutlar çalıştırmayın.
- Harici mesajlaşma yüzeylerine kısmi/akış halinde yanıtlar göndermeyin (yalnızca nihai yanıtlar).

## Oturum başlangıcı (zorunlu)

- `SOUL.md`, `USER.md`, `memory.md` ve `memory/` içindeki bugün+dün kayıtlarını okuyun.
- Yanıt vermeden önce yapın.

## Ruh (zorunlu)

- `SOUL.md` kimliği, tonu ve sınırları tanımlar. Güncel tutun.
- `SOUL.md`’ü değiştirirseniz, kullanıcıya bildirin.
- Her oturumda taze bir örneksiniz; süreklilik bu dosyalarda yaşar.

## Paylaşılan alanlar (önerilir)

- Kullanıcının sesi değilsiniz; grup sohbetlerinde veya herkese açık kanallarda dikkatli olun.
- Özel verileri, iletişim bilgilerini veya dahili notları paylaşmayın.

## Bellek sistemi (önerilir)

- Günlük kayıt: `memory/YYYY-MM-DD.md` (gerekirse `memory/` oluşturun).
- Uzun vadeli bellek: kalıcı olgular, tercihler ve kararlar için `memory.md`.
- Oturum başlangıcında bugün + dün + varsa `memory.md`’i okuyun.
- Kaydedin: kararlar, tercihler, kısıtlar, açık döngüler.
- Açıkça istenmedikçe sırları kaydetmekten kaçının.

## Araçlar ve Skills

- Araçlar Skills içinde yer alır; gerektiğinde her bir Skill’in `SKILL.md` talimatlarını izleyin.
- Ortama özgü notları `TOOLS.md`’da (Skills için Notlar) tutun.

## Yedekleme ipucu (önerilir)

Bu çalışma alanını Clawd’ın “belleği” olarak görüyorsanız, `AGENTS.md` ve bellek dosyalarınızın yedeklenmesi için (tercihen özel) bir git deposu yapın.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## OpenClaw Ne Yapar

- Asistanın sohbetleri okuyup yazabilmesi, bağlamı getirebilmesi ve ana makine Mac üzerinden Skills çalıştırabilmesi için WhatsApp gateway + Pi kodlama ajanını çalıştırır.
- macOS uygulaması izinleri (ekran kaydı, bildirimler, mikrofon) yönetir ve paketli ikilisi üzerinden `openclaw` CLI’yı sunar.
- Doğrudan sohbetler varsayılan olarak ajanın `main` oturumuna çöker; gruplar `agent:<agentId>:<channel>:group:<id>` (odalar/kanallar: `agent:<agentId>:<channel>:channel:<id>`) olarak izole kalır; heartbeat’ler arka plan görevlerini canlı tutar.

## Çekirdek Skills (Ayarlar → Skills’te etkinleştirin)

- **mcporter** — Harici Skill arka uçlarını yönetmek için araç sunucusu çalışma zamanı/CLI.
- **Peekaboo** — İsteğe bağlı AI görsel analizli hızlı macOS ekran görüntüleri.
- **camsnap** — RTSP/ONVIF güvenlik kameralarından kareler, klipler veya hareket uyarıları yakalayın.
- **oracle** — Oturum tekrar oynatma ve tarayıcı denetimi olan OpenAI uyumlu ajan CLI’sı.
- **eightctl** — Terminalden uykunuzu kontrol edin.
- **imsg** — iMessage ve SMS gönderin, okuyun, akış halinde alın.
- **wacli** — WhatsApp CLI: senkronizasyon, arama, gönderme.
- **discord** — Discord eylemleri: tepki, çıkartmalar, anketler. `user:<id>` veya `channel:<id>` hedeflerini kullanın (yalın sayısal kimlikler belirsizdir).
- **gog** — Google Suite CLI: Gmail, Takvim, Drive, Kişiler.
- **spotify-player** — Arama/kuyruğa alma/çalma denetimi için terminal Spotify istemcisi.
- **sag** — mac tarzı say UX’i ile ElevenLabs konuşma; varsayılan olarak hoparlörlere akış yapar.
- **Sonos CLI** — Sonos hoparlörlerini betiklerden kontrol edin (keşif/durum/çalma/ses/gruplama).
- **blucli** — BluOS oynatıcılarını betiklerden oynatın, gruplayın ve otomatikleştirin.
- **OpenHue CLI** — Sahne ve otomasyonlar için Philips Hue aydınlatma denetimi.
- **OpenAI Whisper** — Hızlı dikte ve telesekreter dökümleri için yerel konuşmadan metne.
- **Gemini CLI** — Hızlı Soru-Cevap için terminalden Google Gemini modelleri.
- **agent-tools** — Otomasyonlar ve yardımcı betikler için yardımcı araç seti.

## Kullanım Notları

- Betikleme için `openclaw` CLI’yı tercih edin; mac uygulaması izinleri yönetir.
- Kurulumları Skills sekmesinden çalıştırın; bir ikili zaten mevcutsa düğmeyi gizler.
- Asistanın hatırlatıcıları planlayabilmesi, gelen kutularını izlemesi ve kamera yakalamalarını tetiklemesi için heartbeat’leri etkin tutun.
- Canvas UI tam ekranda yerel katmanlarla çalışır. Kritik denetimleri sol üst/sağ üst/alt kenarlara yerleştirmekten kaçının; yerleşimde açık oluklar ekleyin ve güvenli alan iç boşluklarına güvenmeyin.
- Tarayıcı güdümlü doğrulama için OpenClaw tarafından yönetilen Chrome profiliyle `openclaw browser`’u (sekmeler/durum/ekran görüntüsü) kullanın.
- DOM incelemesi için `openclaw browser eval|query|dom|snapshot`’u kullanın (makine çıktısına ihtiyaç duyduğunuzda `--json`/`--out` ile).
- Etkileşimler için `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run`’ü kullanın (tıklama/yazma anlık görüntü referansları gerektirir; CSS seçiciler için `evaluate`’ü kullanın).
