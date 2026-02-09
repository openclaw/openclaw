---
summary: "ClawHub rehberi: herkese açık Skills kayıt defteri + CLI iş akışları"
read_when:
  - ClawHub’ı yeni kullanıcılara tanıtma
  - Skills yükleme, arama veya yayımlama
  - ClawHub CLI bayraklarını ve senkronizasyon davranışını açıklama
title: "ClawHub"
---

# ClawHub

ClawHub, **OpenClaw için herkese açık Skills kayıt defteridir**. Ücretsiz bir hizmettir: tüm skills herkese açık, açıktır ve paylaşım ile yeniden kullanım için herkes tarafından görülebilir. Bir skill, yalnızca bir `SKILL.md` dosyası (ve buna eşlik eden metin dosyaları) içeren bir klasördür. Skills’leri web uygulamasında gezebilir ya da CLI kullanarak arayabilir, yükleyebilir, güncelleyebilir ve yayımlayabilirsiniz.

Site: [clawhub.ai](https://clawhub.ai)

## ClawHub nedir

- OpenClaw skills’leri için herkese açık bir kayıt defteri.
- Skill paketleri ve meta veriler için sürümlü bir depo.
- Arama, etiketler ve kullanım sinyalleri için bir keşif yüzeyi.

## Nasıl çalışır

1. Bir kullanıcı bir skill paketini (dosyalar + meta veriler) yayımlar.
2. ClawHub paketi depolar, meta verileri ayrıştırır ve bir sürüm atar.
3. Kayıt defteri skill’i arama ve keşif için indeksler.
4. Kullanıcılar OpenClaw içinde skills’leri tarar, indirir ve yükler.

## Neler yapabilirsiniz

- Yeni skills ve mevcut skills’in yeni sürümlerini yayımlamak.
- Ada, etiketlere veya aramaya göre skills keşfetmek.
- Skill paketlerini indirip dosyalarını incelemek.
- Kötüye kullanım veya güvensiz skills’i raporlamak.
- Moderatörseniz gizleme, görünür yapma, silme veya yasaklama işlemleri yapmak.

## 22. Kime yönelik (başlangıç dostu)

OpenClaw ajanınıza yeni yetenekler eklemek istiyorsanız, ClawHub skills bulup yüklemenin en kolay yoludur. Arka ucun nasıl çalıştığını bilmeniz gerekmez. Şunları yapabilirsiniz:

- Skills’i doğal dil ile aramak.
- Bir skill’i çalışma alanınıza yüklemek.
- Skills’i tek bir komutla daha sonra güncellemek.
- Kendi skills’inizi yayımlayarak yedeklemek.

## Hızlı başlangıç (teknik olmayan)

1. CLI’yi yükleyin (bir sonraki bölüme bakın).
2. İhtiyacınız olan bir şeyi arayın:
   - `clawhub search "calendar"`
3. Bir skill yükleyin:
   - `clawhub install <skill-slug>`
4. Yeni skill’in algılanması için yeni bir OpenClaw oturumu başlatın.

## CLI’yi yükleyin

Birini seçin:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## OpenClaw içine nasıl entegre olur

Varsayılan olarak CLI, skills’i geçerli çalışma dizininiz altında `./skills` konumuna yükler. Bir OpenClaw çalışma alanı yapılandırılmışsa, `clawhub`, `--workdir` (veya `CLAWHUB_WORKDIR`) ile geçersiz kılmadığınız sürece o çalışma alanına geri düşer. OpenClaw, çalışma alanı skills’lerini `<workspace>/skills` konumundan yükler ve bunları **bir sonraki** oturumda algılar. Zaten `~/.openclaw/skills` veya paketlenmiş skills kullanıyorsanız, çalışma alanı skills’leri önceliklidir.

Skills’in nasıl yüklendiği, paylaşıldığı ve sınırlandığı hakkında daha fazla ayrıntı için bkz. [Skills](/tools/skills).

## Skill sistemi genel bakış

Bir skill, OpenClaw’a belirli bir görevi nasıl gerçekleştireceğini öğreten, sürümlü bir dosya paketidir. Her yayımlama yeni bir sürüm oluşturur ve kayıt defteri, kullanıcıların değişiklikleri denetleyebilmesi için sürüm geçmişini tutar.

Tipik bir skill şunları içerir:

- Birincil açıklama ve kullanım bilgilerini içeren bir `SKILL.md` dosyası.
- Skill tarafından kullanılan isteğe bağlı yapılandırmalar, betikler veya destekleyici dosyalar.
- Etiketler, özet ve yükleme gereksinimleri gibi meta veriler.

ClawHub, keşfi güçlendirmek ve skill yeteneklerini güvenli biçimde sunmak için meta verileri kullanır.
Kayıt defteri ayrıca sıralama ve görünürlüğü iyileştirmek için kullanım sinyallerini (yıldızlar ve indirmeler gibi) izler.

## Hizmetin sundukları (özellikler)

- Skills ve bunların `SKILL.md` içeriklerinin **herkese açık olarak gezilmesi**.
- Yalnızca anahtar kelimelere değil, gömlemelere (vektör arama) dayalı **arama**.
- **Sürümleme**: semver, değişiklik günlükleri ve etiketler ( `latest` dahil).
- **İndirmeler**: sürüm başına zip olarak.
- **Yıldızlar ve yorumlar** ile topluluk geri bildirimi.
- Onaylar ve denetimler için **moderasyon** kancaları.
- Otomasyon ve betikleme için **CLI dostu API**.

## Güvenlik ve moderasyon

ClawHub varsayılan olarak açıktır. Herkes skills yükleyebilir, ancak yayımlamak için GitHub hesabının en az bir haftalık olması gerekir. Bu, meşru katkıda bulunanları engellemeden kötüye kullanımı yavaşlatmaya yardımcı olur.

Raporlama ve moderasyon:

- Giriş yapmış herhangi bir kullanıcı bir skill’i raporlayabilir.
- Rapor nedenleri zorunludur ve kaydedilir.
- Her kullanıcı aynı anda en fazla 20 aktif rapora sahip olabilir.
- 3’ten fazla benzersiz raporu olan skills varsayılan olarak otomatik gizlenir.
- Moderatörler gizli skills’i görüntüleyebilir, görünür yapabilir, silebilir veya kullanıcıları yasaklayabilir.
- Raporlama özelliğinin kötüye kullanılması hesap yasaklarıyla sonuçlanabilir.

Moderatör olmakla mı ilgileniyorsunuz? OpenClaw Discord’da sorun ve bir moderatör veya bakım sorumlusu ile iletişime geçin.

## CLI komutları ve parametreler

Genel seçenekler (tüm komutlar için geçerlidir):

- `--workdir <dir>`: Çalışma dizini (varsayılan: geçerli dizin; OpenClaw çalışma alanına geri düşer).
- `--dir <dir>`: Skills dizini, workdir’e göreli (varsayılan: `skills`).
- `--site <url>`: Site temel URL’si (tarayıcı girişi).
- `--registry <url>`: Kayıt defteri API temel URL’si.
- `--no-input`: İstemleri devre dışı bırak (etkileşimsiz).
- `-V, --cli-version`: CLI sürümünü yazdır.

Kimlik doğrulama:

- `clawhub login` (tarayıcı akışı) veya `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Seçenekler:

- `--token <token>`: Bir API anahtarı yapıştırın.
- `--label <label>`: Tarayıcı giriş belirteçleri için saklanan etiket (varsayılan: `CLI token`).
- `--no-browser`: Tarayıcı açma ( `--token` gerektirir).

Arama:

- `clawhub search "query"`
- `--limit <n>`: Azami sonuç sayısı.

Yükleme:

- `clawhub install <slug>`
- `--version <version>`: Belirli bir sürümü yükle.
- `--force`: Klasör zaten varsa üzerine yaz.

Güncelleme:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: Belirli bir sürüme güncelle (yalnızca tek slug).
- `--force`: Yerel dosyalar yayımlanmış hiçbir sürümle eşleşmediğinde üzerine yaz.

Listeleme:

- `clawhub list` (`.clawhub/lock.json`’yı okur)

Yayımlama:

- `clawhub publish <path>`
- `--slug <slug>`: Skill slug’ı.
- `--name <name>`: Görünen ad.
- `--version <version>`: Semver sürümü.
- `--changelog <text>`: Değişiklik günlüğü metni (boş olabilir).
- `--tags <tags>`: Virgülle ayrılmış etiketler (varsayılan: `latest`).

Silme/geri alma (yalnızca sahip/yönetici):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Senkronizasyon (yerel skills taraması + yeni/güncellenmişleri yayımlama):

- `clawhub sync`
- `--root <dir...>`: Ek tarama kökleri.
- `--all`: İstemler olmadan her şeyi yükle.
- `--dry-run`: Nelerin yükleneceğini göster.
- `--bump <type>`: Güncellemeler için `patch|minor|major` (varsayılan: `patch`).
- `--changelog <text>`: Etkileşimsiz güncellemeler için değişiklik günlüğü.
- `--tags <tags>`: Virgülle ayrılmış etiketler (varsayılan: `latest`).
- `--concurrency <n>`: Kayıt defteri denetimleri (varsayılan: 4).

## Ajanlar için yaygın iş akışları

### Skills arama

```bash
clawhub search "postgres backups"
```

### Yeni skills indirme

```bash
clawhub install my-skill-pack
```

### Yüklü skills’i güncelleme

```bash
clawhub update --all
```

### Skills’inizi yedekleme (yayımlama veya senkronizasyon)

Tek bir skill klasörü için:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

Birden fazla skill’i aynı anda tarayıp yedeklemek için:

```bash
clawhub sync --all
```

## Gelişmiş ayrıntılar (teknik)

### Sürümleme ve etiketler

- Her yayımlama yeni bir **semver** `SkillVersion` oluşturur.
- `latest` gibi etiketler bir sürüme işaret eder; etiketleri taşımak geri almayı mümkün kılar.
- Değişiklik günlükleri sürüm başına eklenir ve senkronizasyon veya güncelleme yayımlamalarında boş olabilir.

### Yerel değişiklikler ve kayıt defteri sürümleri

Güncellemeler, yerel skill içeriğini bir içerik özeti kullanarak kayıt defteri sürümleriyle karşılaştırır. Yerel dosyalar yayımlanmış hiçbir sürümle eşleşmiyorsa, CLI üzerine yazmadan önce sorar (veya etkileşimsiz çalıştırmalarda `--force` gerektirir).

### Senkronizasyon taraması ve geri dönüş kökleri

`clawhub sync` önce geçerli workdir’i tarar. Hiç skill bulunmazsa, bilinen eski konumlara geri düşer (örneğin `~/openclaw/skills` ve `~/.openclaw/skills`). Bu, ek bayraklar olmadan eski skill yüklemelerini bulmak için tasarlanmıştır.

### Depolama ve kilit dosyası

- Yüklü skills, workdir’iniz altında `.clawhub/lock.json` içinde kaydedilir.
- Kimlik doğrulama belirteçleri ClawHub CLI yapılandırma dosyasında saklanır ( `CLAWHUB_CONFIG_PATH` ile geçersiz kılınabilir).

### Telemetri (yükleme sayıları)

Giriş yapmışken `clawhub sync` çalıştırdığınızda, CLI yükleme sayılarını hesaplamak için asgari bir anlık görüntü gönderir. Bunu tamamen devre dışı bırakabilirsiniz:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Ortam değişkenleri

- `CLAWHUB_SITE`: Site URL’sini geçersiz kılar.
- `CLAWHUB_REGISTRY`: Kayıt defteri API URL’sini geçersiz kılar.
- `CLAWHUB_CONFIG_PATH`: CLI’nin belirteci/yapılandırmayı nerede sakladığını geçersiz kılar.
- `CLAWHUB_WORKDIR`: Varsayılan workdir’i geçersiz kılar.
- `CLAWHUB_DISABLE_TELEMETRY=1`: `sync` üzerinde telemetriyi devre dışı bırakır.
