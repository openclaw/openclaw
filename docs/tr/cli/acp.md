---
summary: "IDE entegrasyonları için ACP köprüsünü çalıştırın"
read_when:
  - ACP tabanlı IDE entegrasyonlarını kurarken
  - ACP oturum yönlendirmesini Gateway’e hata ayıklarken
title: "acp"
---

# acp

OpenClaw Gateway ile konuşan ACP (Agent Client Protocol) köprüsünü çalıştırır.

Bu komut, IDE’ler için stdio üzerinden ACP konuşur ve istemleri WebSocket üzerinden
Gateway’e iletir. ACP oturumlarını Gateway oturum anahtarlarına eşlenmiş halde tutar.

## Kullanım

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## ACP istemcisi (hata ayıklama)

IDE olmadan köprüyü hızlıca doğrulamak için yerleşik ACP istemcisini kullanın.
ACP köprüsünü başlatır ve istemleri etkileşimli olarak yazmanıza olanak tanır.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Nasıl kullanılır

Bir IDE (veya başka bir istemci) Agent Client Protocol konuşuyorsa ve bunun bir
OpenClaw Gateway oturumunu sürmesini istiyorsanız ACP’yi kullanın.

1. Gateway’in çalıştığından emin olun (yerel veya uzak).
2. Gateway hedefini yapılandırın (yapılandırma veya bayraklar).
3. IDE’nizi `openclaw acp`’i stdio üzerinden çalıştıracak şekilde yönlendirin.

Örnek yapılandırma (kalıcı):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Örnek doğrudan çalıştırma (yapılandırma yazmadan):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Ajan seçimi

ACP, ajanları doğrudan seçmez. Gateway oturum anahtarına göre yönlendirir.

Belirli bir ajanı hedeflemek için ajana kapsamlı oturum anahtarlarını kullanın:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Her ACP oturumu tek bir Gateway oturum anahtarına eşlenir. Bir ajanın birçok
oturumu olabilir; anahtarı veya etiketi geçersiz kılmadığınız sürece ACP,
izole bir `acp:<uuid>` oturumu varsayılan olarak kullanır.

## Zed düzenleyici kurulumu

`~/.config/zed/settings.json` içine özel bir ACP ajanı ekleyin (veya Zed’in Ayarlar arayüzünü kullanın):

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Belirli bir Gateway veya ajanı hedeflemek için:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

Zed’de Ajan panelini açın ve bir iş parçacığı başlatmak için “OpenClaw ACP”yi seçin.

## Session mapping

Varsayılan olarak, ACP oturumları `acp:` önekiyle izole bir Gateway oturum anahtarı alır.
Bilinen bir oturumu yeniden kullanmak için bir oturum anahtarı veya etiket geçin:

- `--session <key>`: belirli bir Gateway oturum anahtarı kullanır.
- `--session-label <label>`: etikete göre mevcut bir oturumu çözer.
- `--reset-session`: o anahtar için yeni bir oturum kimliği üretir (aynı anahtar, yeni döküm).

ACP istemciniz meta verileri destekliyorsa, oturum bazında geçersiz kılabilirsiniz:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Oturum anahtarları hakkında daha fazla bilgi için [/concepts/session](/concepts/session) sayfasına bakın.

## Seçenekler

- `--url <url>`: Gateway WebSocket URL’si (yapılandırıldığında varsayılan olarak gateway.remote.url).
- `--token <token>`: Gateway kimlik doğrulama belirteci.
- `--password <password>`: Gateway kimlik doğrulama parolası.
- `--session <key>`: varsayılan oturum anahtarı.
- `--session-label <label>`: çözümlenecek varsayılan oturum etiketi.
- `--require-existing`: oturum anahtarı/etiketi yoksa başarısız ol.
- `--reset-session`: ilk kullanımdan önce oturum anahtarını sıfırla.
- `--no-prefix-cwd`: istemlerin başına çalışma dizinini ekleme.
- `--verbose, -v`: stderr’e ayrıntılı günlükleme.

### `acp client` seçenekleri

- `--cwd <dir>`: ACP oturumu için çalışma dizini.
- `--server <command>`: ACP sunucu komutu (varsayılan: `openclaw`).
- `--server-args <args...>`: ACP sunucusuna iletilen ek argümanlar.
- `--server-verbose`: ACP sunucusunda ayrıntılı günlüklemeyi etkinleştir.
- `--verbose, -v`: ayrıntılı istemci günlüklemesi.
