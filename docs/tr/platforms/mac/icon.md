---
summary: "macOS üzerinde OpenClaw için menü çubuğu simge durumları ve animasyonları"
read_when:
  - Menü çubuğu simgesi davranışını değiştirirken
title: "Menü Çubuğu Simgesi"
---

# Menü Çubuğu Simge Durumları

Yazar: steipete · Güncelleme: 2025-12-06 · Kapsam: macOS uygulaması (`apps/macos`)

- **Boşta:** Normal simge animasyonu (göz kırpma, ara sıra sallanma).
- **Duraklatıldı:** Durum öğesi `appearsDisabled` kullanır; hareket yoktur.
- **Ses tetikleyici (büyük kulaklar):** Sesle uyandırma algılayıcısı, uyandırma sözcüğü duyulduğunda `AppState.triggerVoiceEars(ttl: nil)` çağırır; ifade yakalanırken `earBoostActive=true` korunur. Kulaklar ölçeklenir (1,9x), okunabilirlik için dairesel kulak delikleri oluşur, ardından 1 sn sessizlikten sonra `stopVoiceEars()` ile aşağı düşer. Yalnızca uygulama içi ses hattından tetiklenir.
- **Çalışıyor (ajan çalışıyor):** `AppState.isWorking=true`, “kuyruk/bacak koşuşturması” mikro-hareketini sürer: iş devam ederken daha hızlı bacak kıpırdaması ve hafif bir ofset. Şu anda WebChat ajanı çalışmaları etrafında açılıp kapatılıyor; bağladığınız diğer uzun görevlerin etrafına da aynı anahtarı ekleyin.

Bağlantı noktaları

- Sesle uyandırma: Çalışma zamanı/tester, tetikleme anında `AppState.triggerVoiceEars(ttl: nil)` ve yakalama penceresiyle eşleşmesi için 1 sn sessizlikten sonra `stopVoiceEars()` çağırır.
- Ajan etkinliği: İş aralıkları boyunca `AppStateStore.shared.setWorking(true/false)` ayarlayın (WebChat ajan çağrısında zaten yapıldı). Kısa aralıklar kullanın ve takılı animasyonlardan kaçınmak için `defer` bloklarında sıfırlayın.

Şekiller ve boyutlar

- Temel simge `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)` içinde çizilir.
- Kulak ölçeği varsayılan olarak `1.0`’dir; ses güçlendirme `earScale=1.9`’yi ayarlar ve genel çerçeveyi değiştirmeden `earHoles=true`’ü açıp kapatır (18×18 pt şablon görüntü, 36×36 px Retina arka depoya render edilir).
- Koşuşturma, küçük bir yatay titreşimle birlikte ~1,0’a kadar bacak kıpırdaması kullanır; mevcut herhangi bir boşta sallanmaya eklenir.

Davranışsal notlar

- Kulaklar/çalışma için harici bir CLI/aracı anahtar yoktur; yanlışlıkla çırpınmayı önlemek için bunu uygulamanın kendi sinyallerine içsel tutun.
- Bir iş takılırsa simgenin hızla temel duruma dönmesi için TTL’leri kısa tutun (&lt;10 sn).
