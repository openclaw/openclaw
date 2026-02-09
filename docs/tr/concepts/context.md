---
summary: "Bağlam: modelin ne gördüğü, nasıl oluşturulduğu ve nasıl inceleneceği"
read_when:
  - OpenClaw’da “bağlam”ın ne anlama geldiğini anlamak istiyorsunuz
  - Modelin neden bir şeyi “bildiğini” (ya da unuttuğunu) ayıklıyorsunuz
  - Bağlam yükünü azaltmak istiyorsunuz (/context, /status, /compact)
title: "Context"
---

# Context

“Bağlam”, **OpenClaw’un bir çalıştırma için modele gönderdiği her şeydir**. Modelin **bağlam penceresi** (token sınırı) ile sınırlıdır.

Başlangıç seviyesi zihinsel model:

- **Sistem istemi** (OpenClaw tarafından oluşturulur): kurallar, araçlar, Skills listesi, zaman/çalışma zamanı ve enjekte edilen çalışma alanı dosyaları.
- **Konuşma geçmişi**: bu oturum için sizin mesajlarınız + asistanın mesajları.
- **Araç çağrıları/sonuçları + ekler**: komut çıktıları, dosya okumaları, görseller/sesler vb.

Bağlam, “bellek” ile _aynı şey değildir_: bellek diskte saklanıp daha sonra yeniden yüklenebilir; bağlam ise modelin mevcut penceresinin içindekilerdir.

## Hızlı başlangıç (bağlamı inceleme)

- `/status` → hızlı “pencerem ne kadar dolu?” görünümü + oturum ayarları.
- `/context list` → nelerin enjekte edildiği + yaklaşık boyutlar (dosya başına + toplamlar).
- `/context detail` → daha ayrıntılı döküm: dosya başına, araç şeması başına boyutlar, skill girişi başına boyutlar ve sistem istemi boyutu.
- `/usage tokens` → normal yanıtlara yanıt başına kullanım altbilgisi ekler.
- `/compact` → pencere alanı açmak için eski geçmişi kompakt bir girdiye özetler.

Ayrıca bkz.: [Slash commands](/tools/slash-commands), [Token kullanımı ve maliyetler](/reference/token-use), [Compaction](/concepts/compaction).

## Örnek çıktı

Değerler modele, sağlayıcıya, araç politikasına ve çalışma alanınızdaki içeriğe göre değişir.

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## What counts toward the context window

Modelin aldığı her şey dahildir; buna şunlar da dahil:

- Sistem istemi (tüm bölümler).
- Konuşma geçmişi.
- Araç çağrıları + araç sonuçları.
- Ekler/transkriptler (görseller/sesler/dosyalar).
- Compaction özetleri ve budama (pruning) artıkları.
- Sağlayıcı “sarmalayıcıları” veya gizli başlıklar (görünmezdir, yine de sayılır).

## OpenClaw sistem istemini nasıl oluşturur

Sistem istemi **OpenClaw’a aittir** ve her çalıştırmada yeniden oluşturulur. Şunları içerir:

- Araç listesi + kısa açıklamalar.
- Skills listesi (yalnızca meta veriler; aşağıya bakın).
- Çalışma alanı konumu.
- Zaman (UTC + yapılandırıldıysa dönüştürülmüş kullanıcı zamanı).
- Çalışma zamanı meta verileri (ana makine/İS/model/düşünme).
- **Project Context** altında enjekte edilen çalışma alanı önyükleme dosyaları.

Tam döküm: [System Prompt](/concepts/system-prompt).

## Enjekte edilen çalışma alanı dosyaları (Project Context)

Varsayılan olarak OpenClaw, (varsa) sabit bir çalışma alanı dosyaları kümesini enjekte eder:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (yalnızca ilk çalıştırma)

Büyük dosyalar dosya başına `agents.defaults.bootstrapMaxChars` kullanılarak kesilir (varsayılan `20000` karakter). `/context`, **ham vs enjekte edilen** boyutları ve kesme olup olmadığını gösterir.

## Skills: enjekte edilenler vs isteğe bağlı yüklenenler

Sistem istemi, kompakt bir **skills listesi** (ad + açıklama + konum) içerir. Bu listenin gerçek bir yükü vardır.

Skill talimatları varsayılan olarak dahil edilmez. Modelin, **yalnızca gerektiğinde** skill’in `SKILL.md`’ini `read` etmesi beklenir.

## Araçlar: iki tür maliyet vardır

Araçlar bağlamı iki şekilde etkiler:

1. Sistem istemindeki **araç listesi metni** (“Tooling” olarak gördüğünüz).
2. **Araç şemaları** (JSON). Modelin araçları çağırabilmesi için gönderilirler. Düz metin olarak görmeseniz bile bağlama dahil edilirler.

`/context detail`, en büyük araç şemalarını dökerek neyin baskın olduğunu görmenizi sağlar.

## Komutlar, yönergeler ve “satır içi kısayollar”

Slash komutları Gateway tarafından ele alınır. Birkaç farklı davranış vardır:

- **Bağımsız komutlar**: yalnızca `/...` olan bir mesaj komut olarak çalıştırılır.
- **Yönergeler**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` model mesajı görmeden önce çıkarılır.
  - Yalnızca yönerge içeren mesajlar oturum ayarlarını kalıcılaştırır.
  - Normal bir mesaj içindeki satır içi yönergeler, mesaj başına ipuçları olarak davranır.
- **Satır içi kısayollar** (yalnızca izin listesindeki gönderenler): normal bir mesajın içindeki belirli `/...` belirteçleri hemen çalıştırılabilir (örnek: “hey /status”) ve kalan metni model görmeden önce çıkarılır.

Ayrıntılar: [Slash commands](/tools/slash-commands).

## Oturumlar, compaction ve pruning (kalıcı olanlar)

Mesajlar arasında neyin kalıcı olduğu mekanizmaya bağlıdır:

- **Normal geçmiş**, politika gereği compact/prune edilene kadar oturum dökümünde kalır.
- **Compaction**, bir özeti döküme kalıcı olarak yazar ve son mesajları olduğu gibi tutar.
- **Pruning**, bir çalıştırma için _bellek içi_ istemden eski araç sonuçlarını kaldırır; ancak dökümü yeniden yazmaz.

Belgeler: [Session](/concepts/session), [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning).

## `/context` gerçekte neyi raporlar

`/context`, mümkün olduğunda en son **çalıştırma sırasında oluşturulmuş** sistem istemi raporunu tercih eder:

- `System prompt (run)` = son gömülü (araç çağırabilen) çalıştırmadan yakalanır ve oturum deposunda kalıcılaştırılır.
- `System prompt (estimate)` = bir çalıştırma raporu yoksa (ya da rapor üretmeyen bir CLI arka ucu üzerinden çalıştırılıyorsa) anında hesaplanır.

Her iki durumda da boyutları ve en büyük katkıda bulunanları raporlar; tam sistem istemini veya araç şemalarını **dökmez**.
