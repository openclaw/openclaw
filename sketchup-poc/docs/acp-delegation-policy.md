# ACP Delegation Policy for This Environment

Bu not, özellikle webchat/direct gibi thread-bound ACP session desteği olmayan yüzeylerde nasıl davranılması gerektiğini özetler.

## Varsayılan politika

- Auto completion event'e tek başına güvenme.
- ACP işi `sessions_spawn(runtime="acp", mode="run")` ile başlatıldığında `childSessionKey` değerini sakla.
- Kullanıcı tek final mesaj istiyorsa ara durum spam'i gönderme.
- Sonucu mümkün olduğunda `sessions_history` ile explicit takip ederek çek.
- Completion veya failure gördüğünde tek sentez mesajla kullanıcıya dön.

## Neden?

Bu yüzeyde thread-bound ACP session desteği yok. Bu yüzden background tamamlanma event'lerinin kullanıcıya güvenilir biçimde geri taşınacağı varsayılamaz.

## Uygulama adımları

1. ACP işi spawn et.
2. `childSessionKey` kaydet.
3. Uygun aralıklarla history kontrol et.
4. Completion/failure tespit et.
5. Sonucu sentezle.
6. Tek final mesaj gönder.

## Caveat

- Çok uzun işlerde tek tur içinde bekleme her zaman mümkün olmayabilir.
- Surface/runtime limitleri nedeniyle bazen kontrollü fallback gerekebilir.
- Auto event gelirse bonus olarak değerlendir; ana güvenilir katman explicit history takibidir.
