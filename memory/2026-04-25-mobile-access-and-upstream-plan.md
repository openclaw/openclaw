# 2026-04-25 - Mobile access, upstream basis, and next TUI startup request

## Konuşma özeti

Mert, OpenClaw'ın upstream tarafında sesli iletişimi öne alan ve telefon/saat üzerinden doğrudan erişim sağlayan yetkinlikleri araştırmamı istedi. Workspace içi proje notları ile upstream durumun karışmamasını özellikle netleştirdi; sonrasında araştırmayı yalnızca upstream docs/repo capability yüzeylerine daralttık.

## Upstream araştırmadan çıkan ana sonuç

OpenClaw, yalnızca yazışmalı ajan değil; çoklu erişim yüzeyleri olan bir runtime/access system yönünde ilerliyor.
Öne çıkan upstream dayanaklar:

- audio / voice note transcription
- macOS voice wake + push-to-talk
- iOS mobile node yaklaşımı (voice wake, talk mode, push/relay temeli)
- Android mobile node yaklaşımı (manual voice flow, geniş command surface)
- voice-call plugin ile telephony kanalı
- device pairing + token/scope modeli

## Mert'in vizyonu

Mert, benimle iletişim kurmak ve çalışmak için bilgisayar başına oturmak zorunda kalmadan, ama körlemesine veya yüzeysel bir "konuşmuş olmak için konuşma" hissi olmadan, gerçekten kontrolün kendisinde olduğu kararlı bir mobil erişim deneyimi istiyor.

## Verdiğim net değerlendirme

- Bugünkü upstream gelişmeler bu vizyonu **kısmen karşılıyor**.
- En sağlam başlangıç: mobil webchat.
- Sonraki katman: telefon node (iPhone veya Android).
- Ses katmanı: önce voice note / push-to-talk, sonra wake-word.
- Watch yüzeyi: şimdilik ana kanal değil, yardımcı/handoff yüzeyi olarak düşünülmeli.
- "Kontrol bende" hissi için kritik ilke: aksiyon öncesi onay, net görev tanımı, sonuç/çıktı odaklı kullanım.

## Hazırlanan planlar

Bu konuşmada aşağıdaki planlar çıkarıldı:

1. Bugün başlanabilecek kullanım planı
2. 1 haftalık adoption planı
3. Yüzeyleri hangi sırayla açmak gerektiği
4. Teknik nasıl-yapılır yol haritası:
   - Plan A: mobil webchat ile en güvenli başlangıç
   - Plan B: telefon node kurulumu
   - Plan C: sesli kullanımın kontrollü eklenmesi
5. Kontrolün kullanıcıda kalması için çalışma politikaları

## Kullanım sırası önerisi

1. mobil webchat
2. telefon node
3. voice note / push-to-talk
4. wake-word
5. watch / handoff yüzeyi

## TUI açılışı için istek

Mert, bu son konuşmaların sonraki TUI açılışında terminale yansımasını istiyor.
Bu isteğin teknik yorumu:

- Bir sonraki TUI başlangıcında, son konuşmalardan türetilmiş kısa bir startup summary / welcome context terminale görünmeli.
- Bu yalnızca memory'ye not düşmekten farklı; TUI startup veya session-start surface'inde kullanıcı görünür yansıtma gerektiriyor.
- Hızlı kod incelemesinde ilgili muhtemel yüzeyler tespit edildi:
  - `openclaw-src/src/tui/tui.ts`
  - `openclaw-src/src/tui/gateway-chat.ts`
  - `openclaw-src/src/tui/tui-session-actions.ts`
  - `openclaw-src/src/gateway/session-reset-service.ts`
    Henüz implementasyon yapılmadı; şu an yalnızca istek ve muhtemel giriş noktaları kaydedildi.

## Not

Mert daha sonra bu TUI açılış görünürlüğü isteğinin de uygulanmasını istiyor; şu an sadece kaydedildi.
