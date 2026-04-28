# SolidWorks Kurulum Planı

## Amaç

Bu planın amacı, Windows host üzerinde SolidWorks kurulumu için gerekli önkoşulları, karar noktalarını ve izlenecek uygulama sırasını netleştirmektir.

Bu plan özellikle şu hedefe hizmet eder:

- SolidWorks canlı extraction harness’ini gerçek ortamda test edebilmek
- `get-active-document` ve sonraki extractor adımlarını gerçek host üzerinde doğrulamak

---

## 1. Neden önce kurulum gerekiyor?

Mevcut harness tarafında artık şu noktaya geldik:

- request/result envelope hazır
- queue runner hazır
- live extraction seam hazır
- `get-active-document` için gerçek COM attach denemesi eklendi

Ama Windows host üzerinde SolidWorks kurulu değilse, bu extractor doğal olarak çalışamaz.

Dolayısıyla bir sonraki teknik blokaj artık mimari değil, ortamdır.

---

## 2. Hedef

Kurulum sonrası ulaşmak istediğimiz minimum doğrulama:

- Windows hostta SolidWorks kurulu olacak
- lisans/aktivasyon erişimi olacak
- en az bir kez uygulama açılabilecek
- bir örnek part/assembly aktif doküman haline getirilebilecek
- `get-active-document` live extractor gerçek hosta attach olmayı deneyebilecek

İlk hedef sadece bu kadar.
Henüz metadata/selection/assembly extraction zorunlu değil.

---

## 3. Kurulum için ihtiyaç duyulan kararlar

SolidWorks kurulumundan önce netleşmesi gereken başlıklar:

### 3.1 Hangi sürüm kurulacak?

Tercihen tek bir hedef sürüm seçilmeli.
Örn:

- SolidWorks 2024
- SolidWorks 2025

Harness ve extractor tarafı için sürüm farkı ilk aşamada kritik olmasa da,
kurulum medyası ve lisans tipi açısından önemlidir.

### 3.2 Lisans modeli ne?

Muhtemel seçenekler:

- standalone serial-based lisans
- network/floating lisans
- 3DEXPERIENCE / cloud-linked entitlement
- trial / evaluation benzeri erişim

### 3.3 Kurulum medyası nereden gelecek?

Muhtemel kaynaklar:

- şirket hesabı / resmi Dassault portalı
- mevcut kurulum paketi / ISO / admin image
- Installation Manager üzerinden indirme

### 3.4 Etkileşimli mi kurulacak, yarı-otomatik mi?

İlk kurulum büyük ihtimalle kullanıcı destekli veya yarı-interaktif olacak.
Tam otomasyon hemen hedeflenmemeli.

---

## 4. Önkoşullar

### 4.1 Windows host erişimi

Gerekli:

- Windows tarafında süreç başlatabilen çalışan lane
- tercihen `pwsh.exe` veya benzeri kontrollü komut çalıştırma yolu
- dosya yazma/okuma ve kurulum artifact’lerini kontrol edebilme

### 4.2 Yetki

Kurulum için çoğu durumda:

- yönetici yetkisi
- install/modify izni
- kurumsal güvenlik politikalarıyla uyum

gerekebilir.

### 4.3 Depolama

SolidWorks kurulumları hafif değildir.
Yeterli boş disk alanı olmalı.

### 4.4 Donanım uygunluğu

En azından:

- destekli Windows sürümü
- yeterli RAM
- yeterli CPU
- uygun ekran kartı/driver

---

## 5. Önerilen uygulama sırası

### Faz 1 — Kurulum keşfi

Yapılacaklar:

- hedef SolidWorks sürümünü belirle
- lisans modelini netleştir
- kurulum paketinin kaynağını belirle
- Windows hostta temel donanım/OS uygunluğunu doğrula

### Faz 2 — Kurulum ön kontrolü

Yapılacaklar:

- boş disk alanı kontrolü
- Windows sürümü kontrolü
- RAM kontrolü
- admin yetkisi / installer çalıştırma kabiliyeti
- antivirus / kurumsal policy engeli var mı kontrolü

### Faz 3 — Kurulum

Yapılacaklar:

- Installation Manager veya mevcut kurulum medyası ile yükleme
- gerekli bileşenleri seçme
- lisans/oturum açma adımlarını tamamlama

### Faz 4 — İlk açılış doğrulaması

Yapılacaklar:

- SolidWorks açılıyor mu?
- lisans/activation tamam mı?
- boş belge veya örnek belge açılabiliyor mu?
- COM host erişilebilir mi?

### Faz 5 — Harness doğrulaması

Yapılacaklar:

- `get-active-document` live-only denemesi
- failure/success envelope kontrolü
- artifact kaydı

---

## 6. Pratik kurulum stratejisi

Bence ilk denemede en doğru strateji şu:

### Strateji A — İnsan destekli kurulum

Sen kurulum medyasını ve lisans yolunu sağlarsın.
Ben:

- ön kontrol listesini çıkarırım
- kurulum adımlarını yapılandırırım
- gereken komut/artifact mantığını hazırlarım
- kurulum sonrası harness testini devralırım

Bu, en düşük riskli başlangıç.

### Strateji B — Yarı-otomatik kurulum

Eğer Windows lane tekrar sağlıklı çalışırsa:

- installer path doğrulama
- silent/suppressed install seçeneklerini keşfetme
- log dosyalarını alma
- kurulum sonrası doğrulama

gibi işler daha fazla otomatikleştirilebilir.

Ama ilk adım için Strateji A daha gerçekçi.

---

## 7. Riskler

### Risk 1 — Windows lane hâlâ bozuk olabilir

Şu anki notlara göre WSL -> Windows process bridge tutarlı değil.

**Azaltma:**

- önce Windows tarafı süreç çalıştırma sağlığını düzelt
- gerekirse doğrudan Windows hostta adım adım ilerle

### Risk 2 — Lisans/portal erişimi eksik olabilir

Kurulum teknik olarak mümkün olsa bile lisans blokaj yaratabilir.

**Azaltma:**

- önce lisans modelini netleştir
- kurulum medyasını önceden hazır et

### Risk 3 — Kurulum süreci etkileşimli olabilir

Tam otomasyon ilk aşamada mümkün olmayabilir.

**Azaltma:**

- ilk denemeyi kullanıcı destekli yap
- sonra tekrar eden kısımları otomatikleştir

### Risk 4 — Donanım/driver uyumsuzluğu

Kurulum tamamlansa bile performans veya açılış sorunları olabilir.

**Azaltma:**

- ön kontrolte donanım/driver uygunluğu bakılsın

---

## 8. Minimum başarı kriteri

Bu kurulum işi başarılı sayılmalıysa:

- SolidWorks Windows hostta kurulu olmalı
- açılabiliyor olmalı
- en az bir aktif belge ile çalışabiliyor olmalı
- COM attach denemesi teorik değil pratik hale gelmeli
- harness’in `get-active-document` canlı yolu test edilebilir olmalı

---

## 9. Kurulumdan hemen sonraki ilk harness testi

Kurulum tamamlandıktan sonra ilk teknik test şu olmalı:

### Test 1

`get-active-document` with `extractionMode=live-only`

Beklenen sonuçlar:

- SolidWorks açıksa ve aktif belge varsa: canlı payload
- SolidWorks açık ama belge yoksa: `solidworks-no-active-document`
- SolidWorks açık değilse: `solidworks-host-not-running`

Bu test harness tarafının gerçek dünyaya ilk teması olur.

---

## 10. Şu anda senden gerekecek bilgi

Kuruluma başlamadan önce netleştirilmesi gereken en kritik kullanıcı girdileri:

- hangi SolidWorks sürümünü hedefliyoruz?
- lisans/model erişimi sende var mı?
- kurulum paketi elinde mi, yoksa portal üzerinden mi indirilecek?
- kurulumu doğrudan Windows üzerinde manuel/yönlendirmeli mi yapacağız?

---

## 11. Net öneri

Bu noktada en doğru yaklaşım şu:

1. önce **SolidWorks sürüm + lisans + kurulum kaynağını netleştir**
2. sonra **Windows host kurulum ön kontrolünü yap**
3. ardından **insan destekli ilk kurulumu tamamla**
4. kurulum tamamlanınca hemen **`get-active-document` live test** yap

Bu sıra, harness geliştirmesini gereksiz yere havada bırakmadan gerçek hosta bağlar.
