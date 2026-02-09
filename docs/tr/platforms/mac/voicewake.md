---
summary: "Mac uygulamasında sesle uyandırma ve bas-konuş modları ile yönlendirme ayrıntıları"
read_when:
  - Sesle uyandırma veya PTT yolları üzerinde çalışırken
title: "Sesle Uyandırma"
---

# Sesle Uyandırma ve Bas-Konuş

## Modlar

- **Uyandırma sözcüğü modu** (varsayılan): her zaman açık Konuşma tanıyıcı, tetikleyici belirteçleri (`swabbleTriggerWords`) bekler. Eşleşme olduğunda yakalamayı başlatır, kısmi metinle birlikte kaplamayı gösterir ve sessizlikten sonra otomatik olarak gönderir.
- **Bas-konuş (Sağ Option basılı tutma)**: sağ Option tuşunu basılı tutarak anında yakalama—tetik gerekmez. Basılı tutulurken kaplama görünür; bırakıldığında, metni düzenleyebilmeniz için kısa bir gecikmeden sonra sonlandırır ve iletir.

## Çalışma zamanı davranışı (uyandırma sözcüğü)

- Konuşma tanıyıcı `VoiceWakeRuntime` içinde çalışır.
- Tetik yalnızca uyandırma sözcüğü ile sonraki sözcük arasında **anlamlı bir duraklama** olduğunda (~0,55 sn boşluk) ateşlenir. Kaplama/zil sesi, komut başlamadan önce bile duraklama anında başlayabilir.
- Sessizlik pencereleri: konuşma akıyorken 2,0 sn; yalnızca tetik duyulduysa 5,0 sn.
- Sert durdurma: kaçak oturumları önlemek için 120 sn.
- Oturumlar arası debounce: 350 ms.
- Kaplama, işlenmiş/geçici renklendirme ile `VoiceWakeOverlayController` üzerinden sürülür.
- Gönderimden sonra tanıyıcı, bir sonraki tetik için temiz biçimde yeniden başlar.

## Yaşam döngüsü değişmezleri

- Sesle Uyandırma etkin ve izinler verilmişse, uyandırma sözcüğü tanıyıcısı dinliyor olmalıdır (açık bir bas-konuş yakalaması sırasında hariç).
- Kaplama görünürlüğü (X düğmesiyle manuel kapatma dahil) tanıyıcının yeniden başlamasını asla engellememelidir.

## Yapışkan kaplama arıza modu (önceki)

Önceden, kaplama görünür halde takılı kalır ve siz manuel olarak kapatırsanız, çalışma zamanının yeniden başlatma girişimi kaplama görünürlüğü tarafından engellenebildiği ve sonraki bir yeniden başlatma zamanlanmadığı için Sesle Uyandırma “ölü” görünebilirdi.

Sağlamlaştırma:

- Uyandırma çalışma zamanının yeniden başlatılması artık kaplama görünürlüğü tarafından engellenmez.
- Kaplama kapatma tamamlanması, `VoiceSessionCoordinator` üzerinden bir `VoiceWakeRuntime.refresh(...)` tetikler; böylece manuel X ile kapatma her zaman dinlemeyi sürdürür.

## Bas-konuş ayrıntıları

- Kısayol algılama, **sağ Option** (`keyCode 61` + `.option`) için küresel bir `.flagsChanged` izleyici kullanır. Yalnızca olayları gözlemleriz (yutma yok).
- Yakalama hattı `VoicePushToTalk` içinde yer alır: Konuşma’yı hemen başlatır, kısmi sonuçları kaplamaya akıtır ve bırakmada `VoiceWakeForwarder` çağırır.
- Bas-konuş başladığında, ses girişlerinin çakışmasını önlemek için uyandırma sözcüğü çalışma zamanını duraklatırız; bırakmadan sonra otomatik olarak yeniden başlar.
- İzinler: Mikrofon + Konuşma gerektirir; olayları görmek için Erişilebilirlik/Girdi İzleme onayı gerekir.
- Harici klavyeler: bazıları sağ Option’u beklendiği gibi sunmayabilir—kullanıcılar kaçırmalar bildirse yedek bir kısayol sunun.

## Kullanıcıya yönelik ayarlar

- **Sesle Uyandırma** anahtarı: uyandırma sözcüğü çalışma zamanını etkinleştirir.
- **Konuşmak için Cmd+Fn basılı tut**: bas-konuş izleyicisini etkinleştirir. macOS < 26’da devre dışıdır.
- Dil ve mikrofon seçiciler, canlı seviye ölçer, tetik sözcüğü tablosu, test aracı (yalnızca yerel; iletmez).
- Mikrofon seçici, bir aygıt bağlantısı kesilirse son seçimi korur, bağlantı kesildi ipucunu gösterir ve geri dönene kadar geçici olarak sistem varsayılanına düşer.
- **Sesler**: tetik algılandığında ve gönderimde zil sesleri; varsayılan olarak macOS “Glass” sistem sesi. Her olay için herhangi bir `NSSound`-yüklenebilir dosyayı (örn. MP3/WAV/AIFF) seçebilir veya **Ses Yok**’u seçebilirsiniz.

## Yönlendirme davranışı

- Sesle Uyandırma etkin olduğunda, dökümler etkin gateway/ajan’a iletilir (mac uygulamasının geri kalanında kullanılan aynı yerel vs uzak mod).
- Yanıtlar **son kullanılan ana sağlayıcıya** (WhatsApp/Telegram/Discord/WebChat) teslim edilir. Teslimat başarısız olursa, hata günlüğe kaydedilir ve çalıştırma yine de WebChat/oturum günlükleri üzerinden görünür olur.

## Yük iletimi

- `VoiceWakeForwarder.prefixedTranscript(_:)`, göndermeden önce makine ipucunu başa ekler. Uyandırma sözcüğü ve bas-konuş yolları arasında ortaktır.

## Hızlı doğrulama

- Bas-konuş’u açın, Cmd+Fn basılı tutun, konuşun, bırakın: kaplama kısmi sonuçları göstermeli ve ardından göndermelidir.
- Basılı tutarken menü çubuğu kulakları büyütülmüş kalmalıdır (`triggerVoiceEars(ttl:nil)` kullanır); bırakmadan sonra küçülürler.
