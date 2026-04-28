# Live Extraction Spike Status

## Bu turda bağlanan en küçük canlı akış

- `extract-presentation-context` artık `seeded`, `prefer-live`, `live-only` modlarını gerçekten ayırır.
- `prefer-live` ve `live-only` için yeni seam:
  - Windows host üstünde `SketchUp.exe`
  - `-RubyStartup <script.rb>`
  - `payload.modelPath` ile verilen `.skp` dosyasını aç
  - Ruby tarafında JSON scene context üret
- İlk canlı çıktı `render.source = "sketchup-only"` döndürür.
- V-Ray metadata bu turda bağlı değildir.

## Neden bu yol seçildi

- Bu makinede SketchUp 2026 kurulu.
- Genel COM automation yüzeyi için somut bir kayıt bulunmadı.
- En erişilebilir ve küçültülebilir yüzey SketchUp Ruby extension/startup yolu.
- Aktif açık SketchUp instance'ına dışarıdan attach yerine, kontrollü olarak model dosyasını açıp extraction yapmak MVP için daha uygulanabilir.

## Bilinen blokajlar

- `payload.modelPath` şu an zorunlu.
- Açık mevcut SketchUp oturumuna attach akışı yok.
- V-Ray plugin/metadata bağlantısı bulunamadı; sonuç bu yüzden `sketchup-only`.
- Bu yol GUI uygulama açar; tamamen headless garanti etmez.

## Sonraki mantıklı adım

- Aynı extraction Ruby kodunu kalıcı küçük bir SketchUp extension'a taşı.
- Extension, aktif oturumdan queue/artifact tabanlı istek tüketebilsin.
- Böylece `modelPath` zorunluluğu kalkar ve gerçek "active scene" extraction mümkün olur.
