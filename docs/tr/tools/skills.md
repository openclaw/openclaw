---
summary: "Skills: yönetilen vs çalışma alanı, geçitleme kuralları ve config/env bağlanması"
read_when:
  - Skills eklerken veya değiştirirken
  - Skill geçitlemesini veya yükleme kurallarını değiştirirken
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw, ajana araçları nasıl kullanacağını öğretmek için **[AgentSkills](https://agentskills.io)-uyumlu** skill klasörlerini kullanır. Her skill, YAML frontmatter ve talimatlar içeren bir `SKILL.md` barındıran bir dizindir. OpenClaw, **paketlenmiş skills** ile isteğe bağlı yerel geçersiz kılmaları yükler ve bunları yükleme sırasında ortam, yapılandırma ve ikili (binary) varlığına göre filtreler.

## Konumlar ve öncelik

Skills **üç** yerden yüklenir:

1. **Paketlenmiş skills**: kurulumla birlikte gelir (npm paketi veya OpenClaw.app)
2. **Yönetilen/yerel skills**: `~/.openclaw/skills`
3. **Çalışma alanı skills**: `<workspace>/skills`

Bir skill adı çakışırsa öncelik sırası şöyledir:

`<workspace>/skills` (en yüksek) → `~/.openclaw/skills` → paketlenmiş skills (en düşük)

Ayrıca, `~/.openclaw/openclaw.json` içindeki `skills.load.extraDirs` aracılığıyla ek skill klasörleri (en düşük öncelik) yapılandırabilirsiniz.

## Ajan başına vs paylaşılan skills

**Çok ajanlı** kurulumlarda her ajanın kendi çalışma alanı vardır. Bu şu anlama gelir:

- **Ajan başına skills**, yalnızca o ajan için `<workspace>/skills` içinde bulunur.
- **Paylaşılan skills**, `~/.openclaw/skills` (yönetilen/yerel) içinde bulunur ve aynı makinedeki **tüm ajanlar** tarafından görülebilir.
- **Paylaşılan klasörler**, birden fazla ajanın kullandığı ortak bir skills paketi istiyorsanız `skills.load.extraDirs` aracılığıyla (en düşük öncelik) da eklenebilir.

Aynı skill adı birden fazla yerde varsa, olağan öncelik geçerlidir: çalışma alanı kazanır, ardından yönetilen/yerel, sonra paketlenmiş.

## Eklentiler + skills

Eklentiler, eklenti köküne göre göreli yollar olan `openclaw.plugin.json` içinde `skills` dizinlerini listeleyerek kendi skills’lerini sunabilir. Eklenti etkinleştirildiğinde eklenti skills’leri yüklenir ve normal skill öncelik kurallarına katılır.
Bunları eklentinin yapılandırma girdisindeki `metadata.openclaw.requires.config` ile geçitleyebilirsiniz. Keşif/yapılandırma için [Plugins](/tools/plugin) ve bu skills’lerin öğrettiği araç yüzeyi için [Tools](/tools) sayfalarına bakın.

## ClawHub (kurulum + senkronizasyon)

ClawHub, OpenClaw için herkese açık skills kayıt defteridir. [https://clawhub.com](https://clawhub.com) adresinden göz atın. Skills keşfetmek, kurmak, güncellemek ve yedeklemek için kullanın.
Tam kılavuz: [ClawHub](/tools/clawhub).

Yaygın akışlar:

- Çalışma alanınıza bir skill kurma:
  - `clawhub install <skill-slug>`
- Kurulu tüm skills’leri güncelleme:
  - `clawhub update --all`
- Senkronizasyon (tara + güncellemeleri yayınla):
  - `clawhub sync --all`

Varsayılan olarak, `clawhub` mevcut çalışma dizininiz altında `./skills` içine kurar (ya da yapılandırılmış OpenClaw çalışma alanına geri döner). OpenClaw bunu bir sonraki oturumda `<workspace>/skills` olarak algılar.

## Güvenlik notları

- Üçüncü taraf skills’leri **güvenilmeyen kod** olarak ele alın. Etkinleştirmeden önce inceleyin.
- Güvenilmeyen girdiler ve riskli araçlar için sandbox’lı çalıştırmaları tercih edin. [Sandboxing](/gateway/sandboxing) bölümüne bakın.
- `skills.entries.*.env` ve `skills.entries.*.apiKey`, o ajan turu için sırları **ana makine** sürecine enjekte eder (sandbox’a değil). Sırları istemlerden ve günlüklerden uzak tutun.
- Daha geniş bir tehdit modeli ve kontrol listeleri için [Security](/gateway/security) bölümüne bakın.

## Biçim (AgentSkills + Pi-uyumlu)

`SKILL.md` en azından şunları içermelidir:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Notlar:

- Düzen/amaç için AgentSkills belirtimini izleriz.
- Gömülü ajan tarafından kullanılan ayrıştırıcı yalnızca **tek satırlı** frontmatter anahtarlarını destekler.
- `metadata` **tek satırlı bir JSON nesnesi** olmalıdır.
- Skill klasör yoluna referans vermek için talimatlarda `{baseDir}` kullanın.
- İsteğe bağlı frontmatter anahtarları:
  - `homepage` — macOS Skills UI’da “Website” olarak gösterilen URL (ayrıca `metadata.openclaw.homepage` üzerinden de desteklenir).
  - `user-invocable` — `true|false` (varsayılan: `true`). `true` olduğunda, skill kullanıcı eğik çizgi komutu olarak sunulur.
  - `disable-model-invocation` — `true|false` (varsayılan: `false`). `true` olduğunda, skill model isteminden hariç tutulur (kullanıcı çağrısı ile hâlâ kullanılabilir).
  - `command-dispatch` — `tool` (isteğe bağlı). `tool` olarak ayarlandığında, eğik çizgi komutu modeli atlar ve doğrudan bir araca yönlendirir.
  - `command-tool` — `command-dispatch: tool` ayarlandığında çağrılacak araç adı.
  - `command-arg-mode` — `raw` (varsayılan). Araç yönlendirmesi için ham argüman dizgesini araca iletir (çekirdek ayrıştırma yok).

    Araç şu parametrelerle çağrılır:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Geçitleme (yükleme zamanı filtreleri)

OpenClaw, `metadata` (tek satırlı JSON) kullanarak **skills’leri yükleme zamanında filtreler**:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

`metadata.openclaw` altındaki alanlar:

- `always: true` — skill’i her zaman dahil et (diğer geçitleri atla).
- `emoji` — macOS Skills UI tarafından kullanılan isteğe bağlı emoji.
- `homepage` — macOS Skills UI’da “Website” olarak gösterilen isteğe bağlı URL.
- `os` — isteğe bağlı platform listesi (`darwin`, `linux`, `win32`). Ayarlanırsa, skill yalnızca bu işletim sistemlerinde uygun olur.
- `requires.bins` — liste; her birinin `PATH` üzerinde mevcut olması gerekir.
- `requires.anyBins` — liste; en az birinin `PATH` üzerinde mevcut olması gerekir.
- `requires.env` — liste; ortam değişkeni mevcut olmalı **ya da** yapılandırmada sağlanmış olmalıdır.
- `requires.config` — doğru (truthy) olması gereken `openclaw.json` yollarının listesi.
- `primaryEnv` — `skills.entries.<name>.apiKey` ile ilişkili ortam değişkeni adı.
- `install` — macOS Skills UI tarafından kullanılan isteğe bağlı yükleyici belirtimleri dizisi (brew/node/go/uv/download).

Sandboxing hakkında not:

- `requires.bins`, skill yükleme zamanında **ana makinede** kontrol edilir.
- Bir ajan sandbox’lıysa, ikili **konteyner içinde** de mevcut olmalıdır.
  Bunu `agents.defaults.sandbox.docker.setupCommand` (veya özel bir imaj) ile kurun.
  `setupCommand`, konteyner oluşturulduktan sonra bir kez çalışır.
  Paket kurulumları ayrıca ağ çıkışı, yazılabilir bir kök FS ve sandbox’ta root kullanıcı gerektirir.
  Örnek: `summarize` skill’i (`skills/summarize/SKILL.md`), orada çalışmak için sandbox konteynerinde `summarize` CLI’sine ihtiyaç duyar.

Yükleyici örneği:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

Notlar:

- Birden fazla yükleyici listelenmişse, gateway **tek** bir tercih edilen seçenek seçer (varsa brew, aksi halde node).
- Tüm yükleyiciler `download` ise, OpenClaw mevcut yapıtları görebilmeniz için her girdiyi listeler.
- Yükleyici belirtimleri, seçenekleri platforma göre filtrelemek için `os: ["darwin"|"linux"|"win32"]` içerebilir.
- Node kurulumları, `openclaw.json` içindeki `skills.install.nodeManager`’e uyar (varsayılan: npm; seçenekler: npm/pnpm/yarn/bun).
  Bu yalnızca **skill kurulumlarını** etkiler; Gateway çalışma zamanı yine Node olmalıdır
  (Bun, WhatsApp/Telegram için önerilmez).
- Go kurulumları: `go` yoksa ve `brew` mevcutsa, gateway önce Homebrew üzerinden Go’yu kurar ve mümkün olduğunda `GOBIN`’u Homebrew’un `bin`’ine ayarlar.
- Download kurulumları: `url` (gerekli), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (varsayılan: arşiv algılandığında auto), `stripComponents`, `targetDir` (varsayılan: `~/.openclaw/tools/<skillKey>`).

`metadata.openclaw` yoksa, skill her zaman uygundur (yapılandırmada devre dışı bırakılmadıkça veya paketlenmiş skills için `skills.allowBundled` tarafından engellenmedikçe).

## Yapılandırma geçersiz kılmaları (`~/.openclaw/openclaw.json`)

Paketlenmiş/yönetilen skills açılıp kapatılabilir ve ortam değerleri sağlanabilir:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

Not: Skill adı tire içeriyorsa anahtarı tırnaklayın (JSON5 tırnaklı anahtarlara izin verir).

Yapılandırma anahtarları varsayılan olarak **skill adı** ile eşleşir. Bir skill
`metadata.openclaw.skillKey` tanımlıyorsa, `skills.entries` altında o anahtarı kullanın.

Kurallar:

- `enabled: false` — paketlenmiş/kurulu olsa bile skill’i devre dışı bırakır.
- `env` — değişken süreçte zaten ayarlı **değilse** enjekte edilir.
- `apiKey` — `metadata.openclaw.primaryEnv` bildiren skills için kolaylık sağlar.
- `config` — özel skill başına alanlar için isteğe bağlı torba; özel anahtarlar burada olmalıdır.
- `allowBundled` — yalnızca **paketlenmiş** skills için isteğe bağlı izin listesi. Ayarlanırsa,
  yalnızca listedeki paketlenmiş skills uygundur (yönetilen/çalışma alanı skills etkilenmez).

## Ortam enjeksiyonu (ajan başına çalıştırma)

Bir ajan çalıştırması başladığında OpenClaw:

1. Skill meta verilerini okur.
2. `skills.entries.<key>.env` veya `skills.entries.<key>.apiKey`’yi
   `process.env`’e uygular.
3. **Uygun** skills ile sistem istemini oluşturur.
4. Çalıştırma bittiğinde özgün ortamı geri yükler.

Bu, genel bir kabuk ortamı değil, **ajan çalıştırmasına kapsamlıdır**.

## Oturum anlık görüntüsü (performans)

OpenClaw, **bir oturum başladığında** uygun skills’in anlık görüntüsünü alır ve aynı oturumdaki sonraki turlar için bu listeyi yeniden kullanır. Skills veya yapılandırmadaki değişiklikler bir sonraki yeni oturumda etkili olur.

Skills, skills izleyici etkinleştirildiğinde veya yeni bir uygun uzak düğüm göründüğünde oturum ortasında da yenilenebilir (aşağıya bakın). Bunu bir **hot reload** olarak düşünün: yenilenen liste bir sonraki ajan turunda alınır.

## Uzak macOS düğümleri (Linux gateway)

Gateway Linux üzerinde çalışıyor ancak **macOS düğümü** **`system.run` izinli** olarak bağlıysa (Exec approvals güvenliği `deny` olarak ayarlı değilse), OpenClaw gerekli ikililer o düğümde mevcut olduğunda macOS’a özgü skills’i uygun olarak değerlendirebilir. Ajan bu skills’i `nodes` aracıyla (genellikle `nodes.run`) çalıştırmalıdır.

Bu, düğümün komut desteğini bildirmesine ve `system.run` üzerinden bir bin yoklamasına dayanır. macOS düğümü daha sonra çevrimdışı olursa, skills görünür kalır; düğüm yeniden bağlanana kadar çağrılar başarısız olabilir.

## Skills izleyici (otomatik yenileme)

Varsayılan olarak OpenClaw, skill klasörlerini izler ve `SKILL.md` dosyaları değiştiğinde skills anlık görüntüsünü günceller. Bunu `skills.load` altında yapılandırın:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## Token etkisi (skills listesi)

Skills uygun olduğunda OpenClaw, sistem istemine kullanılabilir skills’in kompakt bir XML listesini enjekte eder (`pi-coding-agent` içindeki `formatSkillsForPrompt` aracılığıyla). Maliyet deterministiktir:

- **Temel ek yük (yalnızca ≥1 skill olduğunda):** 195 karakter.
- **Skill başına:** 97 karakter + XML-kaçışlı `<name>`, `<description>` ve `<location>` değerlerinin uzunluğu.

Formül (karakter):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notlar:

- XML kaçışlama, `& < > " '`’yı varlıklara (`&amp;`, `&lt;`, vb.) genişleterek uzunluğu artırır.
- Token sayıları model tokenleştiricisine göre değişir. Kabaca OpenAI tarzı bir tahmin ~4 karakter/token’dır; dolayısıyla skill başına **97 karakter ≈ 24 token** artı gerçek alan uzunluklarınız.

## Yönetilen skills yaşam döngüsü

OpenClaw, kurulumun bir parçası olarak (npm paketi veya OpenClaw.app) **paketlenmiş skills** şeklinde temel bir skills seti sunar. `~/.openclaw/skills`, yerel geçersiz kılmalar için vardır (örneğin, paketlenmiş kopyayı değiştirmeden bir skill’i sabitlemek/yamalamak). Çalışma alanı skills’leri kullanıcıya aittir ve ad çakışmalarında her ikisini de geçersiz kılar.

## Yapılandırma başvurusu

Tam yapılandırma şeması için [Skills config](/tools/skills-config) sayfasına bakın.

## Daha fazla skill mi arıyorsunuz?

[https://clawhub.com](https://clawhub.com) adresine göz atın.

---
