---
summary: "macOS izinlerinin kalıcılığı (TCC) ve imzalama gereksinimleri"
read_when:
  - Eksik veya takılı kalan macOS izin istemlerini ayıklarken
  - macOS uygulamasını paketlerken veya imzalarken
  - Paket kimliklerini (bundle ID) veya uygulama kurulum yollarını değiştirirken
title: "macOS İzinleri"
---

# macOS izinleri (TCC)

macOS izinleri kırılgandır. TCC, bir izin verilmesini uygulamanın
kod imzası, paket tanımlayıcısı (bundle identifier) ve disk üzerindeki yoluyla ilişkilendirir. Bunlardan herhangi biri değişirse,
macOS uygulamayı yeni olarak değerlendirir ve istemleri düşürebilir veya gizleyebilir.

## Kararlı izinler için gereksinimler

- Aynı yol: uygulamayı sabit bir konumdan çalıştırın (OpenClaw için, `dist/OpenClaw.app`).
- Aynı paket tanımlayıcısı: bundle ID’yi değiştirmek yeni bir izin kimliği oluşturur.
- İmzalı uygulama: imzasız veya ad-hoc imzalı derlemelerde izinler kalıcı olmaz.
- Tutarlı imza: Apple Development veya Developer ID sertifikası kullanın
  böylece imza, yeniden derlemeler arasında kararlı kalır.

Ad-hoc imzalar her derlemede yeni bir kimlik üretir. macOS önceki izinleri unutur
ve eski girdiler temizlenene kadar istemler tamamen kaybolabilir.

## İstemler kaybolduğunda kurtarma kontrol listesi

1. Uygulamadan çıkın.
2. Sistem Ayarları -> Gizlilik ve Güvenlik altında uygulama girdisini kaldırın.
3. Uygulamayı aynı yoldan yeniden başlatın ve izinleri tekrar verin.
4. İstem hâlâ görünmüyorsa, TCC girdilerini `tccutil` ile sıfırlayın ve yeniden deneyin.
5. Bazı izinler yalnızca macOS’un tam bir yeniden başlatılmasından sonra tekrar görünür.

Örnek sıfırlamalar (gerektiğinde bundle ID’yi değiştirin):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Dosyalar ve klasörler izinleri (Masaüstü/Belgeler/İndirilenler)

macOS, terminal/arka plan süreçleri için Masaüstü, Belgeler ve İndirilenler erişimini de kısıtlayabilir. Dosya okumaları veya dizin listelemeleri takılı kalıyorsa, dosya işlemlerini gerçekleştiren aynı süreç bağlamına erişim verin (örneğin Terminal/iTerm, LaunchAgent ile başlatılan uygulama veya SSH süreci).

Geçici çözüm: klasör bazlı izinlerden kaçınmak istiyorsanız dosyaları OpenClaw çalışma alanına (`~/.openclaw/workspace`) taşıyın.

İzinleri test ederken her zaman gerçek bir sertifika ile imzalayın. Ad-hoc
derlemeler, izinlerin önemli olmadığı hızlı yerel çalıştırmalar için kabul edilebilir.
