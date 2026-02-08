---
summary: "OpenClaw belleğinin nasıl çalıştığı (çalışma alanı dosyaları + otomatik bellek boşaltma)"
read_when:
  - Bellek dosyası düzenini ve iş akışını istiyorsanız
  - Otomatik ön-sıkıştırma bellek boşaltmasını ayarlamak istiyorsanız
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:05Z
---

# Bellek

OpenClaw belleği **ajan çalışma alanındaki düz Markdown dosyalarından** oluşur. Dosyalar
tek gerçek kaynaktır; model yalnızca diske yazılanları “hatırlar”.

Bellek arama araçları, etkin bellek eklentisi tarafından sağlanır (varsayılan:
`memory-core`). Bellek eklentilerini `plugins.slots.memory = "none"` ile devre dışı bırakın.

## Bellek dosyaları (Markdown)

Varsayılan çalışma alanı düzeni iki bellek katmanı kullanır:

- `memory/YYYY-MM-DD.md`
  - Günlük kayıt (yalnızca ekleme).
  - Oturum başlangıcında bugün + dün okunur.
- `MEMORY.md` (isteğe bağlı)
  - Küratörlü uzun vadeli bellek.
  - **Yalnızca ana, özel oturumda yüklenir** (grup bağlamlarında asla).

Bu dosyalar çalışma alanı altında bulunur (`agents.defaults.workspace`, varsayılan
`~/.openclaw/workspace`). Tam düzen için [Agent workspace](/concepts/agent-workspace) bölümüne bakın.

## Belleğe ne zaman yazılır

- Kararlar, tercihler ve kalıcı gerçekler `MEMORY.md` dosyasına gider.
- Günlük notlar ve akan bağlam `memory/YYYY-MM-DD.md` dosyasına gider.
- Birisi “bunu hatırla” derse, yazın (RAM’de tutmayın).
- Bu alan hâlâ gelişiyor. Modele anıları kaydetmesini hatırlatmak yardımcı olur; ne yapacağını bilir.
- Bir şeyin kalıcı olmasını istiyorsanız, **botun belleğe yazmasını isteyin**.

## Otomatik bellek boşaltma (ön-sıkıştırma ping’i)

Bir oturum **otomatik sıkıştırmaya yaklaştığında**, OpenClaw bağlam
sıkıştırılmadan **önce** kalıcı belleğin yazılmasını hatırlatan **sessiz,
ajanik bir tur** tetikler. Varsayılan istemler modelin _yanıt verebileceğini_
açıkça söyler; ancak genellikle kullanıcı bu turu hiç görmesin diye doğru yanıt
`NO_REPLY` olur.

Bu davranış `agents.defaults.compaction.memoryFlush` ile denetlenir:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

Ayrıntılar:

- **Yumuşak eşik**: oturum belirteç tahmini `contextWindow - reserveTokensFloor - softThresholdTokens` değerini geçtiğinde boşaltma tetiklenir.
- **Varsayılan olarak sessiz**: istemler, hiçbir şeyin iletilmemesi için `NO_REPLY` içerir.
- **İki istem**: bir kullanıcı istemi ve bir sistem istemi hatırlatmayı ekler.
- **Sıkıştırma döngüsü başına tek boşaltma** (`sessions.json` içinde izlenir).
- **Çalışma alanı yazılabilir olmalıdır**: oturum `workspaceAccess: "ro"` veya
  `"none"` ile sandbox içinde çalışıyorsa boşaltma atlanır.

Tam sıkıştırma yaşam döngüsü için bkz.
[Session management + compaction](/reference/session-management-compaction).

## Vektör bellek araması

OpenClaw, `MEMORY.md` ve `memory/*.md` üzerinde küçük bir vektör dizini
oluşturabilir; böylece anlamsal sorgular, ifade farklı olsa bile ilgili notları
bulabilir.

Varsayılanlar:

- Varsayılan olarak etkindir.
- Bellek dosyalarındaki değişiklikleri izler (debounce’lu).
- Varsayılan olarak uzak embedding’ler kullanır. `memorySearch.provider` ayarlı değilse OpenClaw otomatik olarak seçer:
  1. `local` (bir `memorySearch.local.modelPath` yapılandırılmışsa ve dosya varsa).
  2. Bir OpenAI anahtarı çözümlenebiliyorsa `openai`.
  3. Bir Gemini anahtarı çözümlenebiliyorsa `gemini`.
  4. Bir Voyage anahtarı çözümlenebiliyorsa `voyage`.
  5. Aksi hâlde yapılandırılana kadar bellek araması devre dışı kalır.
- Yerel mod node-llama-cpp kullanır ve `pnpm approve-builds` gerektirebilir.
- SQLite içinde vektör aramasını hızlandırmak için (mevcutsa) sqlite-vec kullanır.

Uzak embedding’ler, embedding sağlayıcısı için bir API anahtarı **gerektirir**.
OpenClaw anahtarları kimlik doğrulama profillerinden, `models.providers.*.apiKey`’den veya
ortam değişkenlerinden çözümler. Codex OAuth yalnızca sohbet/completion’ları
kapsar ve bellek araması için embedding’leri **karşılamaz**. Gemini için
`GEMINI_API_KEY` veya `models.providers.google.apiKey` kullanın. Voyage için `VOYAGE_API_KEY` veya
`models.providers.voyage.apiKey` kullanın. Özel bir OpenAI-uyumlu uç nokta kullanırken
`memorySearch.remote.apiKey`’yi (isteğe bağlı `memorySearch.remote.headers` ile) ayarlayın.

### QMD arka ucu (deneysel)

Yerleşik SQLite dizinleyiciyi [QMD](https://github.com/tobi/qmd) ile değiştirmek
için `memory.backend = "qmd"`’ü ayarlayın: BM25 + vektörler + yeniden sıralamayı birleştiren,
yerel-öncelikli bir arama yan hizmeti. Markdown tek gerçek kaynak olmaya devam
eder; OpenClaw getirim için QMD’yi çağırır. Öne çıkan noktalar:

**Ön koşullar**

- Varsayılan olarak kapalıdır. Yapılandırma bazında etkinleştirin (`memory.backend = "qmd"`).
- QMD CLI’yi ayrı olarak kurun (`bun install -g https://github.com/tobi/qmd` veya bir sürüm indirin) ve
  `qmd` ikilisinin gateway’in `PATH`’inde olduğundan emin olun.
- QMD, uzantılara izin veren bir SQLite derlemesine ihtiyaç duyar (macOS’ta
  `brew install sqlite`).
- QMD, Bun + `node-llama-cpp` üzerinden tamamen yerel çalışır ve ilk kullanımda
  HuggingFace’ten GGUF modellerini otomatik indirir (ayrı bir Ollama daemon’u gerekmez).
- Gateway, `XDG_CONFIG_HOME` ve `XDG_CACHE_HOME` ayarlayarak QMD’yi
  `~/.openclaw/agents/<agentId>/qmd/` altında kendi kendine yeten bir XDG evinde çalıştırır.
- OS desteği: macOS ve Linux, Bun + SQLite kurulduktan sonra kutudan çıktığı gibi çalışır.
  Windows için WSL2 önerilir.

**Yan hizmetin çalışması**

- Gateway, `~/.openclaw/agents/<agentId>/qmd/` altında kendi kendine yeten bir QMD evi yazar
  (yapılandırma + önbellek + sqlite DB).
- Koleksiyonlar, `memory.qmd.paths`’dan (`qmd collection add` ile) oluşturulur
  (varsayılan çalışma alanı bellek dosyaları dâhil); ardından `qmd update` +
  `qmd embed` açılışta ve yapılandırılabilir bir aralıkta
  (`memory.qmd.update.interval`, varsayılan 5 dk) çalışır.
- Açılış yenilemesi artık varsayılan olarak arka planda çalışır; sohbet başlatma
  engellenmez. Önceki engelleyici davranışı korumak için `memory.qmd.update.waitForBootSync = true`’ı ayarlayın.
- Aramalar `qmd query --json` üzerinden çalışır. QMD başarısız olursa veya ikili yoksa,
  OpenClaw otomatik olarak yerleşik SQLite yöneticisine geri döner; böylece bellek
  araçları çalışmaya devam eder.
- OpenClaw bugün QMD embed batch-size ayarını sunmaz; batch davranışı QMD’nin
  kendisi tarafından denetlenir.
- **İlk arama yavaş olabilir**: QMD, ilk `qmd query` çalıştırmada yerel GGUF
  modellerini (yeniden sıralayıcı/sorgu genişletme) indirebilir.
  - OpenClaw, QMD’yi çalıştırırken `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`’ü otomatik ayarlar.
  - Modelleri manuel olarak önceden indirmek (ve OpenClaw’ın kullandığı aynı dizini
    ısıtmak) isterseniz, ajan XDG dizinleriyle tek seferlik bir sorgu çalıştırın.

    OpenClaw’ın QMD durumu **durum dizininiz** altında bulunur (varsayılan
    `~/.openclaw`). OpenClaw’ın kullandığı XDG değişkenlerinin aynısını
    dışa aktararak `qmd`’yı tam olarak aynı dizine yönlendirebilirsiniz:

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**Yapılandırma yüzeyi (`memory.qmd.*`)**

- `command` (varsayılan `qmd`): çalıştırılabilir dosya yolunu geçersiz kılar.
- `includeDefaultMemory` (varsayılan `true`): `MEMORY.md` + `memory/**/*.md`’ü otomatik indeksler.
- `paths[]`: ek dizin/dosyalar ekler (`path`, isteğe bağlı `pattern`, isteğe bağlı
  kararlı `name`).
- `sessions`: oturum JSONL indekslemesine katılım (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: yenileme sıklığını ve bakım yürütümünü denetler:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: geri çağırma yükünü sınırlar (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: [`session.sendPolicy`](/gateway/configuration#session) ile aynı şema.
  Varsayılan DM-only’dir (`deny` tümü, `allow` doğrudan sohbetler);
  grup/kanallarda QMD sonuçlarını göstermek için gevşetin.
- Çalışma alanı dışından kaynaklanan parçalar, `memory_search` sonuçlarında
  `qmd/<collection>/<relative-path>` olarak görünür; `memory_get` bu öneki anlar ve yapılandırılmış
  QMD koleksiyon kökünden okur.
- `memory.qmd.sessions.enabled = true` olduğunda OpenClaw, temizlenmiş oturum dökümlerini
  (Kullanıcı/Yardımcı turları) `~/.openclaw/agents/<id>/qmd/sessions/` altında özel bir QMD koleksiyonuna
  dışa aktarır; böylece `memory_search`, yerleşik SQLite dizinine dokunmadan
  yakın konuşmaları geri çağırabilir.
- `memory_search` parçaları, `memory.citations` `auto`/`on` olduğunda
  artık bir `Source: <path#line>` altbilgisi içerir; yol meta verisini dahili tutmak
  için `memory.citations = "off"`’i ayarlayın (ajan yine `memory_get` için yolu alır,
  ancak parça metni altbilgiyi içermez ve sistem istemi ajana bunu alıntılamamasını söyler).

**Örnek**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**Atıflar ve geri dönüş**

- `memory.citations`, arka uçtan bağımsız olarak geçerlidir
  (`auto`/`on`/`off`).
- `qmd` çalıştığında, tanılamalarda hangi motorun sonuçları sunduğunu
  göstermek için `status().backend = "qmd"` etiketleriz. QMD alt süreci çıkarsa veya JSON
  çıktısı ayrıştırılamazsa, arama yöneticisi bir uyarı kaydeder ve QMD toparlanana
  kadar yerleşik sağlayıcıyı (mevcut Markdown embedding’leri) döndürür.

### Ek bellek yolları

Varsayılan çalışma alanı düzeni dışındaki Markdown dosyalarını indekslemek
istiyorsanız, açık yollar ekleyin:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Notlar:

- Yollar mutlak veya çalışma alanına göreli olabilir.
- Dizinler `.md` dosyaları için özyinelemeli taranır.
- Yalnızca Markdown dosyaları indekslenir.
- Symlink’ler yok sayılır (dosya veya dizin).

### Gemini embedding’leri (yerel)

Gemini embedding’leri API’sini doğrudan kullanmak için sağlayıcıyı
`gemini` olarak ayarlayın:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

Notlar:

- `remote.baseUrl` isteğe bağlıdır (varsayılan Gemini API taban URL’sidir).
- `remote.headers`, gerekirse ek başlıklar eklemenizi sağlar.
- Varsayılan model: `gemini-embedding-001`.

**Özel bir OpenAI-uyumlu uç nokta** (OpenRouter, vLLM veya bir proxy) kullanmak
istiyorsanız, OpenAI sağlayıcısıyla `remote` yapılandırmasını
kullanabilirsiniz:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

Bir API anahtarı ayarlamak istemiyorsanız `memorySearch.provider = "local"`’i kullanın veya
`memorySearch.fallback = "none"`’yı ayarlayın.

Geri dönüşler:

- `memorySearch.fallback`, `openai`, `gemini`, `local` veya
  `none` olabilir.
- Geri dönüş sağlayıcısı yalnızca birincil embedding sağlayıcısı başarısız
  olduğunda kullanılır.

Toplu indeksleme (OpenAI + Gemini):

- OpenAI ve Gemini embedding’leri için varsayılan olarak etkindir. Devre dışı
  bırakmak için `agents.defaults.memorySearch.remote.batch.enabled = false`’yi ayarlayın.
- Varsayılan davranış batch tamamlanmasını bekler; gerekirse
  `remote.batch.wait`, `remote.batch.pollIntervalMs` ve `remote.batch.timeoutMinutes`’i ayarlayın.
- Paralel gönderilecek batch iş sayısını denetlemek için `remote.batch.concurrency`’yı
  ayarlayın (varsayılan: 2).
- Batch modu, `memorySearch.provider = "openai"` veya `"gemini"` olduğunda uygulanır ve ilgili
  API anahtarını kullanır.
- Gemini batch işleri, async embeddings batch uç noktasını kullanır ve Gemini
  Batch API erişimi gerektirir.

OpenAI batch neden hızlı + ucuz:

- Büyük geri doldurmalar için OpenAI, tek bir batch işinde çok sayıda embedding
  isteği gönderebildiğimiz ve OpenAI’nin bunları asenkron işlemesine izin verdiği
  için genellikle desteklediğimiz en hızlı seçenektir.
- OpenAI, Batch API iş yükleri için indirimli fiyatlandırma sunar; bu nedenle
  büyük indeksleme çalışmaları çoğu zaman aynı istekleri eşzamanlı göndermekten
  daha ucuzdur.
- Ayrıntılar için OpenAI Batch API belgeleri ve fiyatlandırmasına bakın:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Yapılandırma örneği:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

Araçlar:

- `memory_search` — dosya + satır aralıklarıyla parçalar döndürür.
- `memory_get` — yola göre bellek dosyası içeriğini okur.

Yerel mod:

- `agents.defaults.memorySearch.provider = "local"`’i ayarlayın.
- `agents.defaults.memorySearch.local.modelPath` sağlayın (GGUF veya `hf:` URI).
- İsteğe bağlı: uzak geri dönüşü önlemek için `agents.defaults.memorySearch.fallback = "none"`’ü ayarlayın.

### Bellek araçları nasıl çalışır

- `memory_search`, `MEMORY.md` + `memory/**/*.md` içindeki Markdown parçalarını
  anlamsal olarak arar (~400 belirteç hedefi, 80 belirteç örtüşme). Parça metnini
  (~700 karakter sınırı), dosya yolunu, satır aralığını, skoru, sağlayıcı/modeli
  ve yerel → uzak embedding’lere geri düşülüp düşülmediğini döndürür. Tam dosya
  içeriği döndürülmez.
- `memory_get`, belirli bir bellek Markdown dosyasını (çalışma alanına göreli),
  isteğe bağlı olarak bir başlangıç satırından ve N satır boyunca okur.
  `MEMORY.md` / `memory/` dışındaki yollar reddedilir.
- Her iki araç da yalnızca ajan için `memorySearch.enabled` true çözümlendiğinde etkindir.

### Neler indekslenir (ve ne zaman)

- Dosya türü: yalnızca Markdown (`MEMORY.md`, `memory/**/*.md`).
- Dizin depolama: ajan başına SQLite, `~/.openclaw/memory/<agentId>.sqlite`’te ( `agents.defaults.memorySearch.store.path` ile
  yapılandırılabilir, `{agentId}` belirteci desteklenir).
- Tazelik: `MEMORY.md` + `memory/` üzerinde izleyici dizini kirli
  işaretler (debounce 1,5 sn). Eşitleme oturum başlangıcında, aramada veya bir
  aralıkta zamanlanır ve asenkron çalışır. Oturum dökümleri, arka plan eşitlemeyi
  tetiklemek için delta eşiklerini kullanır.
- Yeniden indeksleme tetikleyicileri: dizin, embedding **sağlayıcı/model + uç
  nokta parmak izi + parçalara ayırma parametreleri**ni saklar. Bunlardan biri
  değişirse OpenClaw tüm depoyu otomatik olarak sıfırlar ve yeniden indeksler.

### Hibrit arama (BM25 + vektör)

Etkinleştirildiğinde OpenClaw şunları birleştirir:

- **Vektör benzerliği** (anlamsal eşleşme, ifade farklı olabilir)
- **BM25 anahtar kelime uygunluğu** (ID’ler, env değişkenleri, kod sembolleri gibi tam belirteçler)

Platformunuzda tam metin araması yoksa OpenClaw yalnızca vektör aramaya geri döner.

#### Neden hibrit?

Vektör arama “aynı anlama geliyor” durumlarında harikadır:

- “Mac Studio gateway ana makinesi” vs “gateway’i çalıştıran makine”
- “dosya güncellemelerini debounce et” vs “her yazmada indekslemeyi önle”

Ancak tam ve yüksek sinyalli belirteçlerde zayıf olabilir:

- ID’ler (`a828e60`, `b3b9895a…`)
- kod sembolleri (`memorySearch.query.hybrid`)
- hata dizeleri (“sqlite-vec unavailable”)

BM25 (tam metin) bunun tersidir: tam belirteçlerde güçlü, yeniden ifade etmelerde
zayıf. Hibrit arama, pragmatik orta yoldur: **her iki getirim sinyalini de
kullanın**, böylece hem “doğal dil” hem de “samanlıkta iğne” sorgularında iyi
sonuçlar elde edersiniz.

#### Sonuçları nasıl birleştiriyoruz (mevcut tasarım)

Uygulama taslağı:

1. Her iki taraftan aday havuzu alın:

- **Vektör**: kosinüs benzerliğine göre en iyi `maxResults * candidateMultiplier`.
- **BM25**: FTS5 BM25 sıralamasına göre en iyi `maxResults * candidateMultiplier` (daha düşük daha iyidir).

2. BM25 sıralamasını 0..1 benzeri bir skora dönüştürün:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Adayları parça kimliğine göre birleştirin ve ağırlıklı bir skor hesaplayın:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Notlar:

- `vectorWeight` + `textWeight`, yapılandırma çözümlemesinde 1,0’a normalize
  edilir; böylece ağırlıklar yüzde gibi davranır.
- Embedding’ler kullanılamıyorsa (veya sağlayıcı sıfır vektör döndürürse),
  BM25 yine çalıştırılır ve anahtar kelime eşleşmeleri döndürülür.
- FTS5 oluşturulamıyorsa, yalnızca vektör aramayı koruruz (sert hata yok).

Bu “IR-teorisi açısından kusursuz” değil; ancak basit, hızlıdır ve gerçek
notlarda geri çağırma/duyarlılığı artırma eğilimindedir. Daha sonra daha
gelişmiş olmak istersek, yaygın sonraki adımlar Reciprocal Rank Fusion (RRF)
veya karıştırmadan önce skor normalizasyonudur (min/max veya z-skoru).

Yapılandırma:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### Embedding önbelleği

OpenClaw, **parça embedding’lerini** SQLite’ta önbelleğe alabilir; böylece yeniden
indeksleme ve sık güncellemeler (özellikle oturum dökümleri) değişmeyen metni
yeniden embed etmez.

Yapılandırma:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### Oturum belleği araması (deneysel)

İsteğe bağlı olarak **oturum dökümlerini** indeksleyebilir ve bunları
`memory_search` üzerinden sunabilirsiniz. Bu özellik deneysel bir bayrakla
korunur.

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

Notlar:

- Oturum indeksleme **isteğe bağlıdır** (varsayılan olarak kapalı).
- Oturum güncellemeleri debounce edilir ve delta eşiklerini aştıktan sonra
  **asenkron olarak indekslenir** (en iyi çaba).
- `memory_search` indekslemeyi asla beklemez; arka plan eşitlemesi bitene kadar
  sonuçlar biraz eski olabilir.
- Sonuçlar yine yalnızca parçaları içerir; `memory_get` bellek dosyalarıyla
  sınırlı kalır.
- Oturum indeksleme ajan başına yalıtılmıştır (yalnızca o ajanın oturum
  günlükleri indekslenir).
- Oturum günlükleri diskte yaşar (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Dosya sistemi erişimi olan
  herhangi bir süreç/kullanıcı okuyabilir; bu nedenle disk erişimini güven
  sınırı olarak değerlendirin. Daha sıkı yalıtım için ajanları ayrı OS
  kullanıcıları veya ana makineler altında çalıştırın.

Delta eşikleri (varsayılanlar gösterilmiştir):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### SQLite vektör hızlandırma (sqlite-vec)

sqlite-vec uzantısı mevcut olduğunda OpenClaw embedding’leri bir SQLite sanal
tablosunda (`vec0`) saklar ve vektör mesafe sorgularını veritabanında
yürütür. Bu, her embedding’i JS’e yüklemeden aramayı hızlı tutar.

Yapılandırma (isteğe bağlı):

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

Notlar:

- `enabled` varsayılan olarak true’dur; devre dışı bırakıldığında arama,
  saklanan embedding’ler üzerinde süreç içi kosinüs benzerliğine geri döner.
- sqlite-vec uzantısı yoksa veya yüklenemezse OpenClaw hatayı kaydeder ve JS geri
  dönüşüyle devam eder (vektör tablo yok).
- `extensionPath`, paketlenmiş sqlite-vec yolunu geçersiz kılar (özel derlemeler
  veya standart dışı kurulumlar için yararlı).

### Yerel embedding otomatik indirme

- Varsayılan yerel embedding modeli: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0,6 GB).
- `memorySearch.provider = "local"` olduğunda `node-llama-cpp`, `modelPath`’i çözümler; GGUF
  eksikse önbelleğe (veya ayarlıysa `local.modelCacheDir`) **otomatik indirir**, sonra
  yükler. İndirmeler yeniden denemede devam eder.
- Yerel derleme gereksinimi: `pnpm approve-builds` çalıştırın, `node-llama-cpp`’i seçin,
  ardından `pnpm rebuild node-llama-cpp`.
- Geri dönüş: yerel kurulum başarısız olursa ve `memorySearch.fallback = "openai"` ise, otomatik
  olarak uzak embedding’lere geçeriz (`openai/text-embedding-3-small` varsayılan, aksi belirtilmedikçe)
  ve nedeni kaydederiz.

### Özel OpenAI-uyumlu uç nokta örneği

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

Notlar:

- `remote.*`, `models.providers.openai.*`’ya göre önceliklidir.
- `remote.headers`, OpenAI başlıklarıyla birleştirilir; anahtar çakışmalarında
  uzak taraf kazanır. OpenAI varsayılanlarını kullanmak için `remote.headers`’i
  atlayın.
