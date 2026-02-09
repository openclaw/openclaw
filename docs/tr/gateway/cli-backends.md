---
summary: "CLI arka uçları: yerel AI CLI'leri üzerinden yalnızca metin yedek yolu"
read_when:
  - API sağlayıcıları başarısız olduğunda güvenilir bir yedek istediğinizde
  - Claude Code CLI veya diğer yerel AI CLI'lerini çalıştırıyor ve bunları yeniden kullanmak istediğinizde
  - Oturumları ve görüntüleri desteklemeye devam eden, yalnızca metinli ve araçsız bir yol gerektiğinde
title: "CLI Arka Uçları"
---

# CLI arka uçları (yedek çalışma zamanı)

OpenClaw, API sağlayıcıları kapalıyken,
oran sınırlamasına takıldığında veya geçici olarak hatalı davrandığında **yalnızca metinli bir yedek** olarak **yerel AI CLI'lerini** çalıştırabilir. Bu bilinçli olarak temkinli bir yaklaşımdır:

- **Araçlar devre dışıdır** (araç çağrısı yok).
- **Metin gir → metin çık** (güvenilir).
- **Oturumlar desteklenir** (takip eden turların tutarlı kalması için).
- **CLI görüntü yollarını kabul ediyorsa**, **görüntüler iletilebilir**.

Bu, birincil yol yerine bir **güvenlik ağı** olarak tasarlanmıştır. Harici API'lere
bağlanmadan “her zaman çalışan” metin yanıtları istediğinizde kullanın.

## Yeni başlayanlar için hızlı başlangıç

Claude Code CLI'yi **hiçbir yapılandırma olmadan** kullanabilirsiniz (OpenClaw yerleşik bir varsayılanla gelir):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI de kutudan çıktığı gibi çalışır:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Gateway’iniz launchd/systemd altında çalışıyor ve PATH minimal ise, yalnızca
komut yolunu ekleyin:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

Hepsi bu. CLI’nin kendisi dışında anahtar yok, ek kimlik doğrulama yapılandırması yok.

## Yedek olarak kullanma

Birincil modeller başarısız olduğunda çalışması için yedek listenize bir CLI arka ucu ekleyin:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

Notlar:

- `agents.defaults.models` (izin listesi) kullanıyorsanız, `claude-cli/...` eklemelisiniz.
- Birincil sağlayıcı başarısız olursa (kimlik doğrulama, oran sınırlamaları, zaman aşımları),
  OpenClaw sıradaki olarak CLI arka ucunu dener.

## Yapılandırmaya genel bakış

Tüm CLI arka uçları şurada bulunur:

```
agents.defaults.cliBackends
```

Her giriş bir **sağlayıcı kimliği** ile anahtarlanır (örn. `claude-cli`, `my-cli`).
Sağlayıcı kimliği, model referansınızın sol tarafı olur:

```
<provider>/<model>
```

### Örnek yapılandırma

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## Nasıl çalışır

1. **Bir arka uç seçer**, sağlayıcı önekine göre (`claude-cli/...`).
2. **Bir sistem istemi oluşturur**, aynı OpenClaw istemi + çalışma alanı bağlamını kullanarak.
3. **CLI’yi çalıştırır**, geçmişin tutarlı kalması için (destekleniyorsa) bir oturum kimliğiyle.
4. **Çıktıyı ayrıştırır** (JSON veya düz metin) ve nihai metni döndürür.
5. **Oturum kimliklerini kalıcılaştırır**, böylece takip eden istekler aynı CLI oturumunu yeniden kullanır.

## Sessions

- CLI oturumları destekliyorsa, `sessionArg` (örn. `--session-id`) veya
  kimliğin birden fazla bayrağa eklenmesi gerektiğinde `sessionArgs` (yer tutucu `{sessionId}`) ayarlayın.
- CLI farklı bayraklara sahip bir **resume alt komutu** kullanıyorsa,
  `resumeArgs` ayarlayın (devam ederken `args` yerine geçer) ve isteğe bağlı olarak `resumeOutput`
  (JSON olmayan devamlar için).
- `sessionMode`:
  - `always`: her zaman bir oturum kimliği gönder (saklı yoksa yeni bir UUID).
  - `existing`: yalnızca daha önce saklanmış bir oturum kimliği varsa gönder.
  - `none`: asla oturum kimliği gönderme.

## Görüntüler (iletim)

CLI’niz görüntü yollarını kabul ediyorsa, `imageArg` ayarlayın:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw base64 görüntüleri geçici dosyalara yazar. `imageArg` ayarlanırsa, bu
yollar CLI argümanları olarak iletilir. `imageArg` eksikse, OpenClaw dosya
yollarını isteme ekler (yol enjeksiyonu); bu, düz yollardan yerel dosyaları otomatik
yükleyen CLI'ler için yeterlidir (Claude Code CLI davranışı).

## Girdiler / çıktılar

- `output: "json"` (varsayılan) JSON’u ayrıştırmayı ve metin + oturum kimliğini çıkarmayı dener.
- `output: "jsonl"`, JSONL akışlarını (Codex CLI `--json`) ayrıştırır ve
  mevcutsa son ajan mesajını ve `thread_id`’u çıkarır.
- `output: "text"`, stdout’u nihai yanıt olarak ele alır.

Girdi modları:

- `input: "arg"` (varsayılan) istemi son CLI argümanı olarak iletir.
- `input: "stdin"`, istemi stdin üzerinden gönderir.
- İstem çok uzunsa ve `maxPromptArgChars` ayarlıysa, stdin kullanılır.

## Varsayılanlar (yerleşik)

OpenClaw, `claude-cli` için bir varsayılanla gelir:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw ayrıca `codex-cli` için de bir varsayılanla gelir:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Yalnızca gerektiğinde geçersiz kılın (yaygın: mutlak `command` yolu).

## Sınırlamalar

- **OpenClaw araçları yok** (CLI arka ucu hiçbir zaman araç çağrıları almaz). Bazı CLI'ler
  kendi ajan araçlarını yine de çalıştırabilir.
- **Akış yok** (CLI çıktısı toplanır, sonra döndürülür).
- **Yapılandırılmış çıktılar**, CLI’nin JSON formatına bağlıdır.
- **Codex CLI oturumları**, metin çıktısı üzerinden devam eder (JSONL yoktur); bu,
  ilk `--json` çalıştırmasına kıyasla daha az yapılandırılmıştır. OpenClaw
  oturumları yine de normal şekilde çalışır.

## Sorun Giderme

- **CLI bulunamadı**: `command`’i tam bir yol olarak ayarlayın.
- **Yanlış model adı**: `modelAliases` kullanarak `provider/model` → CLI model eşlemesi yapın.
- **Oturum sürekliliği yok**: `sessionArg`’in ayarlı olduğundan ve `sessionMode`’un
  `none` olmadığından emin olun (Codex CLI şu anda JSON çıktısıyla devam edemez).
- **Görüntüler yok sayılıyor**: `imageArg`’i ayarlayın (ve CLI’nin dosya yollarını desteklediğini doğrulayın).
