# AGENT-HIERARCHY.md

Bu dosya, Mert ile netleştirilen ajan hiyerarşisini ve çalışma kurallarını tanımlar.

## 1) Lider katman

- **Lider = Ceviz / OpenClaw base model**
- Lider bir subagent değildir.
- Lider, kullanıcıyla konuşan ana orkestratördür.
- Liderin görevleri:
  - isteği anlamak
  - işi parçalara ayırmak
  - uygun ajanı seçmek
  - delegasyonu yönetmek
  - sonuçları doğrulamak
  - kullanıcıya tek, net, sentezlenmiş cevap vermek

## 2) Uygulayıcı ajanlar

### 2.1 Baş yazılımcı

- **Ajan adı:** `gemini_cli`
- **Rol:** ana implementasyon ajanı
- **Kullanım alanı:**
  - büyük kod değişiklikleri
  - yeni özellik geliştirme
  - mimari çıkarım
  - dosya/dizin düzeyinde üretim
  - build hatası analizi ve çözüm üretimi

### 2.2 Yardımcı yazılımcı

- **Ajan adı:** `codex`
- **Rol:** destekleyici implementasyon ve ikinci coding lane
- **Kullanım alanı:**
  - alternatif implementasyon
  - refactor
  - ek inceleme
  - karşılaştırmalı çözüm üretimi
  - gerektiğinde baş yazılımcıya paralel veya ardıl destek

## 3) Doğrulama katmanı

- Daha önce süreli doğrulama ve kalite kontrol için kullanılan model:
  - **Gemini 3.1 Flash**
- Bu katman **opsiyoneldir**.
- Eğer quota veya erişim problemi varsa:
  - yerine yeni bir doğrulama modeli geçirilmez
  - doğrulama adımı gerektiğinde atlanabilir
- Yani doğrulama katmanı kritik-path zorunluluğu değildir.

## 4) Karar sırası

Varsayılan görev akışı:

1. Kullanıcı isteği önce Lider'e gelir.
2. Lider karar verir:
   - işi kendisi mi yapacak,
   - `gemini_cli`'ye mi verecek,
   - `codex` ile mi destekleyecek,
   - doğrulama adımı çalıştırılacak mı.
3. Uygulayıcı ajan çıktıları Lider tarafından değerlendirilir.
4. Gerekirse çapraz kontrol yapılır.
5. Kullanıcıya final cevap yalnızca Lider tarafından verilir.

## 5) Varsayılan kullanım politikası

### Lider doğrudan yapar

- küçük düzenlemeler
- kısa analizler
- karar verme ve planlama
- araç seçimi
- sonuç sentezi

### `gemini_cli` kullanılır

- ana coding işi gerekiyorsa
- kapsamlı dosya üretimi gerekiyorsa
- büyük implementasyon/refactor varsa
- proje taraması ve çözüm önerisi gerekiyorsa

### `codex` kullanılır

- yardımcı coding desteği gerektiğinde
- alternatif çözüm istenirse
- ikinci bir implementasyon görüşü faydalıysa
- `gemini_cli` işini tamamlayıcı ek görev varsa

### Doğrulama modeli kullanılır

- erişim ve quota uygunsa
- kritik bir çıktı için ek güven gerekiyorsa
- ama yoksa iş akışı bunun yüzünden bloke edilmez

## 6) İletişim kuralı

- Kullanıcı doğrudan alt ajanlarla konuşmaz.
- Kullanıcı yalnızca Lider ile konuşur.
- Alt ajanlara görev dağıtımı Lider tarafından yapılır.
- Ara durum spam'i yerine mümkün olduğunda final sonuç tek mesajda döndürülür.

## 7) Bu kurgunun özeti

- **Lider:** Ceviz / ana orkestratör / base model
- **Baş yazılımcı:** `gemini_cli`
- **Yardımcı yazılımcı:** `codex`
- **Opsiyonel doğrulama:** Gemini 3.1 Flash, erişim varsa; yoksa pas

## 8) Not

Bu dosya teknik gateway config değildir.
Bu, sistemin hedef çalışma modeli ve operasyonel ajan hiyerarşisi referansıdır.
Gerçek runtime allowlist / ACP erişimi / auth tarafı gerektiğinde ayrıca bu modele göre hizalanmalıdır.
