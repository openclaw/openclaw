---
summary: "Giden kanallar için Markdown biçimlendirme hattı"
read_when:
  - Giden kanallar için Markdown biçimlendirme veya parçalama değiştirildiğinde
  - Yeni bir kanal biçimlendiricisi veya stil eşlemesi eklendiğinde
  - Kanallar arasında biçimlendirme regresyonları ayıklandığında
title: "Markdown Biçimlendirme"
---

# Markdown biçimlendirme

OpenClaw, giden Markdown’ı kanala özgü çıktıyı oluşturmadan önce paylaşılan bir ara
temsile (IR) dönüştürerek biçimlendirir. IR, kaynak metni olduğu gibi korurken
stil/bağlantı aralıklarını taşır; böylece parçalama ve render işlemleri kanallar
arasında tutarlı kalır.

## Hedefler

- **Tutarlılık:** tek ayrıştırma adımı, birden fazla render motoru.
- **Güvenli parçalama:** satır içi biçimlendirme parçalara bölünmeden önce metni ayırma.
- **Kanala uyum:** Markdown’ı yeniden ayrıştırmadan aynı IR’yi Slack mrkdwn, Telegram HTML
  ve Signal stil aralıklarına eşleme.

## Pipeline

1. **Markdown ayrıştırma -> IR**
   - IR, düz metin ile stil aralıkları (kalın/italik/üstü çizili/kod/spoiler) ve bağlantı aralıklarından oluşur.
   - Ofsetler UTF-16 kod birimleridir; böylece Signal stil aralıkları API’siyle hizalanır.
   - Tablolar yalnızca bir kanal tablo dönüşümünü seçtiğinde ayrıştırılır.
2. **IR’yi parçalama (önce biçim)**
   - Parçalama, render’dan önce IR metni üzerinde yapılır.
   - Satır içi biçimlendirme parçalara bölünmez; aralıklar parça başına dilimlenir.
3. **Kanal başına render**
   - **Slack:** mrkdwn belirteçleri (kalın/italik/üstü çizili/kod), bağlantılar `<url|label>` olarak.
   - **Telegram:** HTML etiketleri (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** düz metin + `text-style` aralıkları; etiket URL’den farklıysa bağlantılar `label (url)` olur.

## IR örneği

Girdi Markdown:

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (şematik):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Nerede kullanılır

- Slack, Telegram ve Signal giden adaptörleri IR’den render eder.
- Diğer kanallar (WhatsApp, iMessage, MS Teams, Discord) hâlâ düz metin veya kendi
  biçimlendirme kurallarını kullanır; Markdown tablo dönüşümü etkinse parçalamadan
  önce uygulanır.

## Tablo işleme

Markdown tabloları sohbet istemcileri arasında tutarlı biçimde desteklenmez. Kanal
(ve hesap) bazında dönüşümü denetlemek için `markdown.tables` kullanın.

- `code`: tabloları kod blokları olarak render et (çoğu kanal için varsayılan).
- `bullets`: her satırı madde işaretlerine dönüştür (Signal + WhatsApp için varsayılan).
- `off`: tablo ayrıştırma ve dönüşümünü devre dışı bırak; ham tablo metni olduğu gibi geçer.

Yapılandırma anahtarları:

```yaml
channels:
  discord:
    markdown:
      tables: code
    accounts:
      work:
        markdown:
          tables: off
```

## Parçalama kuralları

- Parça sınırları kanal adaptörleri/yapılandırmadan gelir ve IR metnine uygulanır.
- Kod çitleri, kanalların doğru render etmesi için sonda bir yeni satırla tek blok
  olarak korunur.
- Liste önekleri ve alıntı önekleri IR metninin parçasıdır; bu nedenle parçalama
  öneklerin ortasında bölmez.
- Satır içi stiller (kalın/italik/üstü çizili/satır içi kod/spoiler) asla parçalara
  bölünmez; render motoru her parça içinde stilleri yeniden açar.

Kanallar arasında parçalama davranışı hakkında daha fazlası için
[Streaming + chunking](/concepts/streaming) bölümüne bakın.

## Bağlantı politikası

- **Slack:** `[label](url)` -> `<url|label>`; yalın URL’ler yalın kalır. Çift
  bağlantılamayı önlemek için ayrıştırma sırasında otomatik bağlantılama kapalıdır.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (HTML ayrıştırma modu).
- **Signal:** etiket URL ile eşleşmedikçe `[label](url)` -> `label (url)`.

## Spoiler’lar

Spoiler işaretleri (`||spoiler||`) yalnızca Signal için ayrıştırılır ve SPOILER
stil aralıklarına eşlenir. Diğer kanallar bunları düz metin olarak ele alır.

## Kanal biçimlendiricisi ekleme veya güncelleme

1. **Tek seferde ayrıştırma:** kanala uygun seçeneklerle (autolink, başlık stili,
   alıntı öneki) paylaşılan `markdownToIR(...)` yardımcısını kullanın.
2. **Render:** `renderMarkdownWithMarkers(...)` ve bir stil işaretleyici eşlemesi (veya Signal stil
   aralıkları) ile bir render motoru uygulayın.
3. **Parçalama:** render’dan önce `chunkMarkdownIR(...)` çağırın; her parçayı render edin.
4. **Adaptörü bağlama:** kanal giden adaptörünü yeni parçalayıcıyı ve render motorunu
   kullanacak şekilde güncelleyin.
5. **Test:** biçim testleri ekleyin veya güncelleyin; kanal parçalama kullanıyorsa
   bir giden teslimat testi ekleyin.

## Common gotchas

- Slack köşeli parantez belirteçleri (`<@U123>`, `<#C123>`, `<https://...>`) korunmalıdır; ham HTML’yi güvenle kaçışlayın.
- Telegram HTML, bozuk işaretlemeyi önlemek için etiketler dışındaki metnin kaçışlanmasını gerektirir.
- Signal stil aralıkları UTF-16 ofsetlerine bağlıdır; kod noktası ofsetlerini kullanmayın.
- Çitli kod blokları için sondaki yeni satırları koruyun; kapanış işaretleri kendi satırlarında kalsın.
