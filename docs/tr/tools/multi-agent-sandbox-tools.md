---
summary: "Ajan başına sandbox ve araç kısıtlamaları, öncelik ve örnekler"
title: Çok Ajanlı Sandbox ve Araçlar
read_when: "Çok ajanlı bir Gateway’de ajan başına sandboxing veya ajan başına araç izin/verme ya da engelleme politikaları istiyorsanız."
status: active
---

# Çok Ajanlı Sandbox ve Araçlar Yapılandırması

## Genel bakış

Çok ajanlı bir kurulumda her ajan artık kendi ayarlarına sahip olabilir:

- **Sandbox yapılandırması** (`agents.list[].sandbox` `agents.defaults.sandbox`’i geçersiz kılar)
- **Araç kısıtlamaları** (`tools.allow` / `tools.deny`, ayrıca `agents.list[].tools`)

Bu, farklı güvenlik profillerine sahip birden fazla ajan çalıştırmanıza olanak tanır:

- Tam erişimli kişisel asistan
- Kısıtlı araçlara sahip aile/iş ajanları
- Sandbox içinde herkese açık ajanlar

`setupCommand`, `sandbox.docker` (global veya ajan başına) altında yer alır ve
konteyner oluşturulduğunda bir kez çalışır.

Kimlik doğrulama ajan başınadır: her ajan, kendi `agentDir` kimlik doğrulama deposunu
şu konumdan okur:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Kimlik bilgileri ajanlar arasında **paylaşılmaz**. `agentDir`’yi ajanlar arasında asla yeniden kullanmayın.
Kimlik bilgilerini paylaşmak istiyorsanız, `auth-profiles.json`’ü diğer ajanın `agentDir`’üne kopyalayın.

Sandboxing’in çalışma zamanındaki davranışı için [Sandboxing](/gateway/sandboxing) bölümüne bakın.
“Bu neden engellendi?” sorusunun hata ayıklaması için [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) ve `openclaw sandbox explain`’e bakın.

---

## Yapılandırma Örnekleri

### Örnek 1: Kişisel + Kısıtlı Aile Ajanı

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**Sonuç:**

- `main` ajanı: Ana makinede çalışır, tam araç erişimi
- `family` ajanı: Docker içinde çalışır (ajan başına bir konteyner), yalnızca `read` aracı

---

### Örnek 2: Paylaşılan Sandbox ile İş Ajanı

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### Örnek 2b: Global kodlama profili + yalnızca mesajlaşma ajanı

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**Sonuç:**

- 33. varsayılan ajanlar kodlama araçlarına sahiptir
- `support` ajanı yalnızca mesajlaşma içindir (+ Slack aracı)

---

### Örnek 3: Ajan Başına Farklı Sandbox Modları

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## Yapılandırma Önceliği

Hem global (`agents.defaults.*`) hem de ajan-özel (`agents.list[].*`) yapılandırmalar mevcut olduğunda:

### Sandbox Yapılandırması

Ajan-özel ayarlar global ayarları geçersiz kılar:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Notlar:**

- `agents.list[].sandbox.{docker,browser,prune}.*`, ilgili ajan için `agents.defaults.sandbox.{docker,browser,prune}.*`’ü geçersiz kılar (sandbox kapsamı `"shared"`’e çözümlendiğinde yok sayılır).

### 34. Araç Kısıtlamaları

Filtreleme sırası:

1. **Araç profili** (`tools.profile` veya `agents.list[].tools.profile`)
2. **Sağlayıcı araç profili** (`tools.byProvider[provider].profile` veya `agents.list[].tools.byProvider[provider].profile`)
3. **Global araç politikası** (`tools.allow` / `tools.deny`)
4. **Sağlayıcı araç politikası** (`tools.byProvider[provider].allow/deny`)
5. **Ajan-özel araç politikası** (`agents.list[].tools.allow/deny`)
6. **Ajan sağlayıcı politikası** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Sandbox araç politikası** (`tools.sandbox.tools` veya `agents.list[].tools.sandbox.tools`)
8. **Alt ajan araç politikası** (`tools.subagents.tools`, varsa)

Her seviye araçları daha da kısıtlayabilir, ancak önceki seviyelerde reddedilen araçları geri veremez.
`agents.list[].tools.sandbox.tools` ayarlanırsa, ilgili ajan için `tools.sandbox.tools`’in yerini alır.
`agents.list[].tools.profile` ayarlanırsa, ilgili ajan için `tools.profile`’yi geçersiz kılar.
Sağlayıcı araç anahtarları, `provider` (örn. `google-antigravity`) veya `provider/model` (örn. `openai/gpt-5.2`) kabul eder.

### Araç grupları (kısayollar)

Araç politikaları (global, ajan, sandbox) birden çok somut araca genişleyen `group:*` girdilerini destekler:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: tüm yerleşik OpenClaw araçları (sağlayıcı eklentileri hariç)

### Elevated Modu

`tools.elevated` global temel çizgidir (gönderene dayalı izin listesi). `agents.list[].tools.elevated`, belirli ajanlar için elevated’ı daha da kısıtlayabilir (ikisi de izin vermelidir).

Azaltma desenleri:

- Güvenilmeyen ajanlar için `exec`’yi reddedin (`agents.list[].tools.deny: ["exec"]`)
- Kısıtlı ajanlara yönlendiren göndericileri izin listesine almaktan kaçının
- Yalnızca sandbox içinde yürütme istiyorsanız elevated’ı global olarak devre dışı bırakın (`tools.elevated.enabled: false`)
- Hassas profiller için elevated’ı ajan başına devre dışı bırakın (`agents.list[].tools.elevated.enabled: false`)

---

## 35. Tek Ajandan Geçiş

36. **Önce (tek ajan):**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**Sonra (farklı profillere sahip çok ajan):**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

Eski `agent.*` yapılandırmaları `openclaw doctor` tarafından taşınır; bundan sonra `agents.defaults` + `agents.list` tercih edin.

---

## Araç Kısıtlama Örnekleri

### 37. Salt okunur Ajan

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Güvenli Yürütme Ajanı (dosya değişikliği yok)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Yalnızca İletişim Ajanı

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Yaygın Tuzak: "non-main"

`agents.defaults.sandbox.mode: "non-main"`, ajan kimliğine değil `session.mainKey`’ya (varsayılan `"main"`) dayanır. Grup/kanal oturumları her zaman kendi anahtarlarını alır; bu nedenle non-main olarak
ele alınır ve sandbox içine alınır. Bir ajanın asla sandbox’a girmemesini istiyorsanız
`agents.list[].sandbox.mode: "off"`’i ayarlayın.

---

## Test Etme

Çok ajanlı sandbox ve araçları yapılandırdıktan sonra:

1. **Ajan çözümlemesini kontrol edin:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Sandbox konteynerlerini doğrulayın:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Araç kısıtlamalarını test edin:**
   - Kısıtlı araçlar gerektiren bir mesaj gönderin
   - Ajanın reddedilen araçları kullanamadığını doğrulayın

4. **Günlükleri izleyin:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Sorun Giderme

### `mode: "all"` olmasına rağmen ajan sandbox’a alınmıyor

- Bunu geçersiz kılan global bir `agents.defaults.sandbox.mode` olup olmadığını kontrol edin
- Ajan-özel yapılandırma önceliklidir; bu nedenle `agents.list[].sandbox.mode: "all"`’i ayarlayın

### Reddetme listesine rağmen araçlar hâlâ kullanılabilir

- Araç filtreleme sırasını kontrol edin: global → ajan → sandbox → alt ajan
- Her seviye yalnızca daha fazla kısıtlayabilir, geri veremez
- Günlüklerle doğrulayın: `[tools] filtering tools for agent:${agentId}`

### Konteyner ajan başına izole değil

- Ajan-özel sandbox yapılandırmasında `scope: "agent"`’ü ayarlayın
- Varsayılan `"session"`’tür; bu, oturum başına bir konteyner oluşturur

---

## Ayrıca Bakın

- [Çok Ajanlı Yönlendirme](/concepts/multi-agent)
- [Sandbox Yapılandırması](/gateway/configuration#agentsdefaults-sandbox)
- [Oturum Yönetimi](/concepts/session)
