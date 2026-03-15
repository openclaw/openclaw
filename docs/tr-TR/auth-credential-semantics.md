# Kimlik Bilgisi Anlamları

Bu belge, şu alanlarda kullanılan standart kimlik bilgisi uygunluk ve çözümleme kurallarını tanımlar:

- `resolveAuthProfileOrder`
- `resolveApiKeyForProfile`
- `models status --probe`
- `doctor-auth`

Amaç, seçim zamanı ve çalışma zamanı davranışını uyumlu tutmaktır.

## Stabil Neden Kodları

- `ok`
- `missing_credential` (kimlik bilgisi eksik)
- `invalid_expires` (geçersiz son kullanma)
- `expired` (süresi dolmuş)
- `unresolved_ref` (çözümlenemeyen referans)

## Token Kimlik Bilgileri

Token kimlik bilgileri (`type: "token"`) satır içi `token` ve/veya `tokenRef` destekler.

### Uygunluk kuralları

1. Bir token profili, hem `token` hem de `tokenRef` yoksa uygun değildir.
2. `expires` isteğe bağlıdır.
3. Eğer `expires` mevcutsa, `0`'dan büyük sonlu bir sayı olmalıdır.
4. Eğer `expires` geçersizse (`NaN`, `0`, negatif, sonlu değil veya yanlış tip), profil `invalid_expires` nedeniyle uygun değildir.
5. Eğer `expires` geçmişteyse, profil `expired` nedeniyle uygun değildir.
6. `tokenRef`, `expires` doğrulamasını atlamaz.

### Çözümleme kuralları

1. Çözümleyici semantikleri, `expires` için uygunluk semantikleriyle eşleşir.
2. Uygun profiller için, token materyali satır içi değerden veya `tokenRef`'den çözümlenebilir.
3. Çözümlenemeyen referanslar, `models status --probe` çıktısında `unresolved_ref` üretir.

## Eski Uyumlu Mesajlar

Komut dosyası uyumluluğu için, prob hataları bu ilk satırı değişmeden tutar:

`Auth profile credentials are missing or expired.`

(Auth profili kimlik bilgileri eksik veya süresi dolmuş.)

İnsan dostu ayrıntılar ve stabil neden kodları sonraki satırlarda eklenebilir.
