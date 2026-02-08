---
summary: "Çoklu ajan yönlendirmesi: yalıtılmış ajanlar, kanal hesapları ve bağlamalar"
title: Çoklu Ajan Yönlendirmesi
read_when: "Tek bir gateway sürecinde birden fazla yalıtılmış ajan (çalışma alanları + kimlik doğrulama) istiyorsunuz."
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:27Z
---

# Çoklu Ajan Yönlendirmesi

Amaç: tek bir çalışan Gateway içinde birden fazla _yalıtılmış_ ajan (ayrı çalışma alanı + `agentDir` + oturumlar) ve birden fazla kanal hesabı (örn. iki WhatsApp). Gelen mesajlar, bağlamalar aracılığıyla bir ajana yönlendirilir.

## “Tek ajan” nedir?

Bir **ajan**, aşağıdakilerin her birine sahip, kapsamı tamamen ayrılmış bir beyindir:

- **Çalışma alanı** (dosyalar, AGENTS.md/SOUL.md/USER.md, yerel notlar, persona kuralları).
- **Durum dizini** (`agentDir`) — kimlik doğrulama profilleri, model kayıt defteri ve ajan başına yapılandırma.
- **Oturum deposu** (sohbet geçmişi + yönlendirme durumu) — `~/.openclaw/agents/<agentId>/sessions` altında.

Kimlik doğrulama profilleri **ajan başınadır**. Her ajan, kendi aşağıdaki kaynağından okur:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Ana ajan kimlik bilgileri otomatik olarak **paylaşılmaz**. `agentDir`’yi
ajanlar arasında asla yeniden kullanmayın (kimlik doğrulama/oturum çakışmalarına yol açar).
Kimlik bilgilerini paylaşmak istiyorsanız, `auth-profiles.json`’yi diğer ajanın
`agentDir` dizinine kopyalayın.

Skills, her çalışma alanının `skills/` klasörü üzerinden ajan başınadır; paylaşılan Skills
`~/.openclaw/skills`’dan kullanılabilir. Bkz. [Skills: ajan başına vs paylaşılan](/tools/skills#per-agent-vs-shared-skills).

Gateway **tek bir ajanı** (varsayılan) veya **birden çok ajanı** yan yana barındırabilir.

**Çalışma alanı notu:** her ajanın çalışma alanı **varsayılan cwd**’dir; katı bir
sandbox değildir. Göreli yollar çalışma alanı içinde çözülür; ancak mutlak yollar,
sandboxing etkin değilse ana makinedeki diğer konumlara erişebilir. Bkz.
[Sandboxing](/gateway/sandboxing).

## Yollar (hızlı harita)

- Yapılandırma: `~/.openclaw/openclaw.json` (veya `OPENCLAW_CONFIG_PATH`)
- Durum dizini: `~/.openclaw` (veya `OPENCLAW_STATE_DIR`)
- Çalışma alanı: `~/.openclaw/workspace` (veya `~/.openclaw/workspace-<agentId>`)
- Ajan dizini: `~/.openclaw/agents/<agentId>/agent` (veya `agents.list[].agentDir`)
- Oturumlar: `~/.openclaw/agents/<agentId>/sessions`

### Tek ajan modu (varsayılan)

Hiçbir şey yapmazsanız, OpenClaw tek bir ajan çalıştırır:

- `agentId` varsayılan olarak **`main`**’dir.
- Oturumlar `agent:main:<mainKey>` olarak anahtarlanır.
- Çalışma alanı varsayılan olarak `~/.openclaw/workspace`’dur ( `OPENCLAW_PROFILE` ayarlandığında `~/.openclaw/workspace-<profile>` ).
- Durum varsayılan olarak `~/.openclaw/agents/main/agent`’dir.

## Ajan yardımcısı

Yeni bir yalıtılmış ajan eklemek için ajan sihirbazını kullanın:

```bash
openclaw agents add work
```

Ardından, gelen mesajları yönlendirmek için `bindings` ekleyin (veya sihirbazın eklemesine izin verin).

Doğrulamak için:

```bash
openclaw agents list --bindings
```

## Birden fazla ajan = birden fazla kişi, birden fazla kişilik

**Birden fazla ajan** ile her bir `agentId` **tamamen yalıtılmış bir persona** olur:

- **Farklı telefon numaraları/hesaplar** (kanal başına `accountId`).
- **Farklı kişilikler** (ajan başına çalışma alanı dosyaları, örn. `AGENTS.md` ve `SOUL.md`).
- **Ayrı kimlik doğrulama + oturumlar** (açıkça etkinleştirilmedikçe çapraz etkileşim yoktur).

Bu, **birden fazla kişinin** tek bir Gateway sunucusunu paylaşmasına olanak tanırken AI “beyinlerini” ve verilerini yalıtılmış tutar.

## Tek WhatsApp numarası, birden fazla kişi (DM bölme)

**Tek bir WhatsApp hesabı** üzerinde kalırken **farklı WhatsApp DM’lerini** farklı ajanlara yönlendirebilirsiniz. Gönderen E.164 (örn. `+15551234567`) ile `peer.kind: "dm"` üzerinden eşleştirin. Yanıtlar yine aynı WhatsApp numarasından gelir (ajan başına gönderici kimliği yoktur).

Önemli ayrıntı: doğrudan sohbetler ajanın **ana oturum anahtarına** çöker; gerçek yalıtım için **kişi başına bir ajan** gerekir.

Örnek:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

Notlar:

- DM erişim denetimi **WhatsApp hesabı başına küreseldir** (eşleştirme/izin listesi), ajan başına değildir.
- Paylaşılan gruplar için, grubu tek bir ajana bağlayın veya [Yayın grupları](/channels/broadcast-groups) kullanın.

## Yönlendirme kuralları (mesajlar nasıl ajan seçer)

Bağlamalar **deterministiktir** ve **en spesifik olan kazanır**:

1. `peer` eşleşmesi (tam DM/grup/kanal kimliği)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. Bir kanal için `accountId` eşleşmesi
5. Kanal düzeyi eşleşme (`accountId: "*"`)
6. Varsayılan ajana geri dönüş (`agents.list[].default`, aksi halde ilk liste girdisi; varsayılan: `main`)

## Birden fazla hesap / telefon numarası

**Birden fazla hesabı** destekleyen kanallar (örn. WhatsApp), her oturumu tanımlamak için `accountId` kullanır.
Her bir `accountId` farklı bir ajana yönlendirilebilir; böylece tek bir sunucu,
oturumları karıştırmadan birden fazla telefon numarasını barındırabilir.

## Kavramlar

- `agentId`: tek bir “beyin” (çalışma alanı, ajan başına kimlik doğrulama, ajan başına oturum deposu).
- `accountId`: tek bir kanal hesabı örneği (örn. WhatsApp hesabı `"personal"` vs `"biz"`).
- `binding`: gelen mesajları `(channel, accountId, peer)` ve isteğe bağlı olarak lonca/takım kimliklerine göre bir `agentId`’e yönlendirir.
- Doğrudan sohbetler `agent:<agentId>:<mainKey>`’ya çöker (ajan başına “ana”; `session.mainKey`).

## Örnek: iki WhatsApp → iki ajan

`~/.openclaw/openclaw.json` (JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## Örnek: WhatsApp günlük sohbet + Telegram derin çalışma

Kanala göre bölün: WhatsApp’ı hızlı günlük ajana, Telegram’ı Opus ajana yönlendirin.

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

Notlar:

- Bir kanal için birden fazla hesabınız varsa, bağlamaya `accountId` ekleyin (örneğin `{ channel: "whatsapp", accountId: "personal" }`).
- Kalanları sohbette tutarken tek bir DM/grubu Opus’a yönlendirmek için, o eş için bir `match.peer` bağlaması ekleyin; eş eşleşmeleri her zaman kanal genelindeki kuralları yener.

## Örnek: aynı kanal, bir eşi Opus’a

WhatsApp’ı hızlı ajan üzerinde tutun, ancak tek bir DM’yi Opus’a yönlendirin:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Eş bağlamaları her zaman kazanır; bu nedenle kanal genelindeki kuralın üzerinde tutun.

## Bir WhatsApp grubuna bağlı aile ajanı

Bahsetme kapılaması ve daha sıkı bir araç politikası ile,
tek bir WhatsApp grubuna adanmış bir aile ajanı bağlayın:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

Notlar:

- Araç izin/verme listeleri **araçlar** içindir, Skills değildir. Bir Skill bir ikili çalıştırmak zorundaysa,
  `exec`’nin izinli olduğundan ve ikilinin sandbox içinde mevcut olduğundan emin olun.
- Daha sıkı kapılama için `agents.list[].groupChat.mentionPatterns` ayarlayın ve
  kanal için grup izin listelerini etkin tutun.

## Ajan Başına Sandbox ve Araç Yapılandırması

v2026.1.6’dan itibaren her ajan kendi sandbox ve araç kısıtlamalarına sahip olabilir:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

Not: `setupCommand`, `sandbox.docker` altında bulunur ve konteyner oluşturma sırasında bir kez çalışır.
Çözümlenen kapsam `"shared"` olduğunda, ajan başına `sandbox.docker.*` geçersiz kılmaları yok sayılır.

**Faydalar:**

- **Güvenlik yalıtımı**: Güvenilmeyen ajanlar için araçları kısıtlayın
- **Kaynak denetimi**: Bazı ajanları sandbox içine alırken diğerlerini ana makinede tutun
- **Esnek politikalar**: Ajan başına farklı izinler

Not: `tools.elevated` **küreseldir** ve gönderici temellidir; ajan başına yapılandırılamaz.
Ajan başına sınırlar gerekiyorsa, `agents.list[].tools` kullanarak `exec`’i reddedin.
Grup hedefleme için, @bahsetmelerin doğru ajana temiz biçimde eşlenmesi amacıyla `agents.list[].groupChat.mentionPatterns` kullanın.

Ayrıntılı örnekler için [Çoklu Ajan Sandbox & Araçlar](/tools/multi-agent-sandbox-tools) bölümüne bakın.
