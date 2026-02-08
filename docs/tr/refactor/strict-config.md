---
summary: "Katı yapılandırma doğrulaması + yalnızca doctor tarafından yapılan geçişler"
read_when:
  - Yapılandırma doğrulama davranışını tasarlarken veya uygularken
  - Yapılandırma geçişleri ya da doctor iş akışları üzerinde çalışırken
  - Eklenti yapılandırma şemalarını veya eklenti yükleme kapılamasını ele alırken
title: "Katı Yapılandırma Doğrulaması"
x-i18n:
  source_path: refactor/strict-config.md
  source_hash: 5bc7174a67d2234e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:44Z
---

# Katı yapılandırma doğrulaması (yalnızca doctor geçişleri)

## Hedefler

- **Bilinmeyen yapılandırma anahtarlarını her yerde reddetmek** (kök + iç içe).
- **Şeması olmayan eklenti yapılandırmasını reddetmek**; o eklentiyi yüklememek.
- **Yükleme sırasında eski otomatik geçişleri kaldırmak**; geçişler yalnızca doctor üzerinden çalışır.
- **Başlangıçta doctor’ı (dry-run) otomatik çalıştırmak**; geçersizse tanılama dışı komutları engellemek.

## Hedef dışı

- Yükleme sırasında geriye dönük uyumluluk (eski anahtarlar otomatik geçiş yapmaz).
- Tanınmayan anahtarların sessizce atılması.

## Katı doğrulama kuralları

- Yapılandırma, her seviyede şemayla birebir eşleşmelidir.
- Bilinmeyen anahtarlar doğrulama hatasıdır (kök veya iç içe geçiş yoktur).
- `plugins.entries.<id>.config` eklentinin şeması tarafından doğrulanmalıdır.
  - Bir eklentide şema yoksa, **eklenti yüklemesini reddedin** ve açık bir hata gösterin.
- Bilinmeyen `channels.<id>` anahtarları, bir eklenti manifestosu kanal kimliğini beyan etmedikçe hatadır.
- Eklenti manifestoları (`openclaw.plugin.json`) tüm eklentiler için zorunludur.

## Eklenti şeması zorunluluğu

- Her eklenti, yapılandırması için katı bir JSON Şeması sağlar (manifesto içinde satır içi).
- Eklenti yükleme akışı:
  1. Eklenti manifestosunu + şemayı çözümle (`openclaw.plugin.json`).
  2. Yapılandırmayı şemaya göre doğrula.
  3. Şema yoksa veya yapılandırma geçersizse: eklenti yüklemesini engelle, hatayı kaydet.
- Hata iletisi şunları içerir:
  - Eklenti kimliği
  - Neden (şema yok / geçersiz yapılandırma)
  - Doğrulamada başarısız olan yol(lar)
- Devre dışı eklentiler yapılandırmalarını korur; ancak Doctor + günlükler bir uyarı gösterir.

## Doctor akışı

- Doctor, yapılandırma her yüklendiğinde **her zaman** çalışır (varsayılan olarak dry-run).
- Yapılandırma geçersizse:
  - Bir özet + eyleme geçirilebilir hatalar yazdırır.
  - Talimat verir: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Geçişleri uygular.
  - Bilinmeyen anahtarları kaldırır.
  - Güncellenmiş yapılandırmayı yazar.

## Komut kapılama (yapılandırma geçersizken)

İzin verilenler (yalnızca tanılama):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Diğer her şey şu hata ile kesin olarak başarısız olmalıdır: “Yapılandırma geçersiz. `openclaw doctor --fix` çalıştırın.”

## Hata UX biçimi

- Tek bir özet başlığı.
- Gruplandırılmış bölümler:
  - Bilinmeyen anahtarlar (tam yollar)
  - Eski anahtarlar / gerekli geçişler
  - Eklenti yükleme hataları (eklenti kimliği + neden + yol)

## Uygulama temas noktaları

- `src/config/zod-schema.ts`: kök passthrough’u kaldır; her yerde katı nesneler.
- `src/config/zod-schema.providers.ts`: katı kanal şemalarını güvenceye al.
- `src/config/validation.ts`: bilinmeyen anahtarlarda başarısız ol; eski geçişleri uygulama.
- `src/config/io.ts`: eski otomatik geçişleri kaldır; doctor dry-run’u her zaman çalıştır.
- `src/config/legacy*.ts`: kullanımı yalnızca doctor’a taşı.
- `src/plugins/*`: şema kayıt defteri + kapılama ekle.
- `src/cli` içinde CLI komut kapılaması.

## Testler

- Bilinmeyen anahtar reddi (kök + iç içe).
- Eklenti şeması eksik → eklenti yüklemesi açık bir hatayla engellenir.
- Geçersiz yapılandırma → gateway (ağ geçidi) başlangıcı tanılama komutları dışında engellenir.
- Doctor dry-run otomatik; `doctor --fix` düzeltilmiş yapılandırmayı yazar.
