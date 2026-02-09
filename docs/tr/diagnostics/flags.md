---
summary: "Diagnostics flags for targeted debug logs"
read_when:
  - Küresel günlükleme seviyelerini yükseltmeden hedefli hata ayıklama günlüklerine ihtiyaç duyduğunuzda
  - You need to capture subsystem-specific logs for support
title: "Tanılama Bayrakları"
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

## Env override (one-off)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Tüm bayrakları devre dışı bırakma:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Günlüklerin gittiği yer

Bayraklar, günlükleri standart tanılama günlük dosyasına yazar. Varsayılan olarak:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file` ayarlarsanız bunun yerine o yolu kullanır. Günlükler JSONL biçimindedir (satır başına bir JSON nesnesi). `logging.redactSensitive`’ye bağlı olarak maskeleme (redaction) uygulanmaya devam eder.

## Extract logs

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
