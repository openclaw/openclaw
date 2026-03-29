# HMAC-SHA256: Fundamentals & Cryptographic Guarantees

#v16_knowledge #hmac #cryptography #hft

## Table of Contents

- [Overview](#overview)
- [How HMAC Works](#how-hmac-works)
- [Security Properties](#security-properties)
- [Key Length Requirements](#key-length-requirements)
- [Common Pitfalls](#common-pitfalls)

## Overview

HMAC (Hash-based Message Authentication Code) с использованием SHA-256 — стандарт де-факто для аутентификации API-запросов в HFT и торговых платформах, включая Dmarket. HMAC обеспечивает **целостность данных** и **аутентификацию источника**.

> «HMAC can be used with any iterative cryptographic hash function, e.g., MD5, SHA-1, in combination with a secret shared key.» — RFC 2104

## How HMAC Works

Алгоритм оперирует двумя проходами хеширования:

```
HMAC(K, m) = H((K' ⊕ opad) || H((K' ⊕ ipad) || m))
```

Где:

- `K'` — ключ, дополненный нулями до размера блока (64 байта для SHA-256)
- `ipad` = `0x36` повторённый до размера блока
- `opad` = `0x5C` повторённый до размера блока
- `H` = SHA-256

## Security Properties

| Свойство          | Гарантия                                                            |
| ----------------- | ------------------------------------------------------------------- | --- | ----- |
| Message Integrity | Изменение даже 1 бита payload меняет весь HMAC                      |
| Authentication    | Только владелец секрета может создать валидный HMAC                 |
| Replay Protection | Достигается добавлением timestamp/nonce в payload                   |
| Length Extension  | HMAC **защищён** от length-extension атак (в отличие от naive H(key |     | msg)) |

## Key Length Requirements

- Минимум: 256 бит (32 байта) для SHA-256
- Рекомендация RFC 2104: длина ключа ≥ длина hash output
- Dmarket API использует ключи Base64-encoded длиной 44 символа (~32 байта)

## Common Pitfalls

1. **Timing attacks**: Используй `hmac.compare_digest()` вместо `==`
2. **Key exposure**: Никогда не логируй секретный ключ
3. **Encoding mismatch**: Payload должен быть в одной кодировке (UTF-8) на клиенте и сервере
4. **Replay**: Всегда включай timestamp с окном валидности (±30с)

---

_Сгенерировано Knowledge Expansion v16.5_
