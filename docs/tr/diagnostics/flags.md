---
summary: "Hedefli hata ayıklama günlükleri için tanılama bayrakları"
read_when:
  - Küresel günlükleme seviyelerini yükseltmeden hedefli hata ayıklama günlüklerine ihtiyaç duyduğunuzda
  - Destek için alt sistemlere özgü günlükleri yakalamanız gerektiğinde
title: "Tanılama Bayrakları"
x-i18n:
  source_path: diagnostics/flags.md
  source_hash: daf0eca0e6bd1cbc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:11Z
---

# Tanılama Bayrakları

Tanılama bayrakları, her yerde ayrıntılı günlüklemeyi açmadan hedefli hata ayıklama günlüklerini etkinleştirmenizi sağlar. Bayraklar isteğe bağlıdır ve bir alt sistem bunları kontrol etmediği sürece etkisizdir.

## Nasıl çalışır

- Bayraklar dizgelerdir (büyük/küçük harfe duyarsız).
- Bayrakları yapılandırma üzerinden veya bir ortam değişkeni geçersiz kılmasıyla etkinleştirebilirsiniz.
- Joker karakterler desteklenir:
  - `telegram.*` , `telegram.http` ile eşleşir
  - `*` tüm bayrakları etkinleştirir

## Yapılandırma ile etkinleştirme

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Birden fazla bayrak:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Bayrakları değiştirdikten sonra gateway’i yeniden başlatın.

## Ortam değişkeniyle geçersiz kılma (tek seferlik)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Tüm bayrakları devre dışı bırakma:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Günlüklerin konumu

Bayraklar, günlükleri standart tanılama günlük dosyasına yazar. Varsayılan olarak:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file` ayarlarsanız bunun yerine o yolu kullanır. Günlükler JSONL biçimindedir (satır başına bir JSON nesnesi). `logging.redactSensitive`’ye bağlı olarak maskeleme (redaction) uygulanmaya devam eder.

## Günlükleri çıkarma

En son günlük dosyasını seçin:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Telegram HTTP tanılama günlüklerini filtreleyin:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

Ya da yeniden üretirken takip edin (tail):

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Uzak gateway’ler için ayrıca `openclaw logs --follow`’ü kullanabilirsiniz (bkz. [/cli/logs](/cli/logs)).

## Notlar

- `logging.level`, `warn`’ten daha yüksek ayarlanırsa bu günlükler bastırılabilir. Varsayılan `info` uygundur.
- Bayrakları etkin bırakmak güvenlidir; yalnızca ilgili alt sistem için günlük hacmini etkiler.
- Günlük hedeflerini, seviyeleri ve maskelemeyi değiştirmek için [/logging](/logging) sayfasını kullanın.
