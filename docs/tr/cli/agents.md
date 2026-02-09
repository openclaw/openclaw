---
summary: "`openclaw agents` için CLI referansı (listeleme/ekleme/silme/kimlik ayarlama)"
read_when:
  - Birden fazla yalıtılmış ajan (çalışma alanları + yönlendirme + kimlik doğrulama) istediğinizde
title: "cli/agents.md"
---

# `openclaw agents`

Yalıtılmış ajanları (çalışma alanları + kimlik doğrulama + yönlendirme) yönetin.

İlgili:

- Çoklu ajan yönlendirme: [Multi-Agent Routing](/concepts/multi-agent)
- Ajan çalışma alanı: [Agent workspace](/concepts/agent-workspace)

## Örnekler

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## Kimlik dosyaları

Her ajan çalışma alanı, çalışma alanı kök dizininde bir `IDENTITY.md` içerebilir:

- Örnek yol: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity`, çalışma alanı kök dizininden (veya açıkça belirtilen bir `--identity-file`) okur

Avatar yolları, çalışma alanı kök dizinine göre çözümlenir.

## Kimlik ayarla

`set-identity`, alanları `agents.list[].identity` içine yazar:

- `name`
- `theme`
- `emoji`
- `avatar` (çalışma alanına göreli yol, http(s) URL veya data URI)

`IDENTITY.md` üzerinden yükle:

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

Alanları açıkça geçersiz kıl:

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

Yapılandırma örneği:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```
