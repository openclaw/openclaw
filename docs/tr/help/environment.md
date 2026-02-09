---
summary: "OpenClaw'ın ortam değişkenlerini nereden yüklediği ve öncelik sırası"
read_when:
  - Hangi ortam değişkenlerinin yüklendiğini ve hangi sırayla yüklendiğini bilmeniz gerekir
  - Gateway'de eksik API anahtarlarını hata ayıklarken
  - Sağlayıcı kimlik doğrulaması veya dağıtım ortamlarını belgelendirirken
title: "Ortam Değişkenleri"
---

# Ortam değişkenleri

OpenClaw, ortam değişkenlerini birden fazla kaynaktan alır. Kural şudur: **mevcut değerleri asla geçersiz kılma**.

## Öncelik (en yüksek → en düşük)

1. **Process environment** (Gateway sürecinin üst kabuk/daemon’dan zaten aldığı değerler).
2. **Geçerli çalışma dizinindeki `.env`** (dotenv varsayılanı; geçersiz kılmaz).
3. **`~/.openclaw/.env` konumundaki genel `.env`** (diğer adıyla `$OPENCLAW_STATE_DIR/.env`; geçersiz kılmaz).
4. **`~/.openclaw/openclaw.json` içindeki Config `env` bloğu** (yalnızca eksikse uygulanır).
5. **İsteğe bağlı login-shell içe aktarma** (`env.shellEnv.enabled` veya `OPENCLAW_LOAD_SHELL_ENV=1`), yalnızca beklenen anahtarlar eksikse uygulanır.

Yapılandırma dosyası tamamen eksikse, 4. adım atlanır; shell içe aktarma etkinse yine de çalışır.

## Config `env` bloğu

Satır içi ortam değişkenlerini ayarlamanın iki eşdeğer yolu (ikisi de geçersiz kılmaz):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Shell env içe aktarma

`env.shellEnv`, login shell’inizi çalıştırır ve yalnızca **eksik** beklenen anahtarları içe aktarır:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Ortam değişkeni eşdeğerleri:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Yapılandırmada ortam değişkeni ikamesi

Yapılandırmadaki dize değerlerinde ortam değişkenlerine `${VAR_NAME}` sözdizimini kullanarak doğrudan başvurabilirsiniz:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

Ayrıntılar için [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) bölümüne bakın.

## İlgili

- [Gateway yapılandırması](/gateway/configuration)
- [SSS: env vars ve .env yükleme](/help/faq#env-vars-and-env-loading)
- [Modeller genel bakış](/concepts/models)
