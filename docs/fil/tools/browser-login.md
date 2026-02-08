---
summary: "Manu-manong pag-login para sa browser automation + pag-post sa X/Twitter"
read_when:
  - Kailangan mong mag-log in sa mga site para sa browser automation
  - Gusto mong mag-post ng mga update sa X/Twitter
title: "Browser Login"
x-i18n:
  source_path: tools/browser-login.md
  source_hash: c30faa9da6c6ef70
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:56Z
---

# Browser login + pag-post sa X/Twitter

## Manu-manong pag-login (inirerekomenda)

Kapag nangangailangan ng login ang isang site, **mag-sign in nang manu-mano** sa **host** na browser profile (ang OpenClaw browser).

Huwag **ibigay** sa model ang iyong mga kredensyal. Ang mga automated na login ay madalas mag-trigger ng mga anti‑bot defense at maaaring mag-lock ng account.

Bumalik sa pangunahing browser docs: [Browser](/tools/browser).

## Aling Chrome profile ang ginagamit?

Kinokontrol ng OpenClaw ang isang **dedikadong Chrome profile** (pinangalanang `openclaw`, may kahel na UI). Hiwalay ito sa iyong pang-araw-araw na browser profile.

Dalawang madaling paraan para ma-access ito:

1. **Hilingin sa agent na buksan ang browser** at pagkatapos ay ikaw mismo ang mag-log in.
2. **Buksan ito gamit ang CLI**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

Kung mayroon kang maraming profile, ipasa ang `--browser-profile <name>` (ang default ay `openclaw`).

## X/Twitter: inirerekomendang daloy

- **Pagbasa/paghahanap/threads:** gamitin ang **host** browser (manu-manong login).
- **Pag-post ng mga update:** gamitin ang **host** browser (manu-manong login).

## Sandboxing + access sa host browser

Ang mga sandboxed na browser session ay **mas malamang** na mag-trigger ng bot detection. Para sa X/Twitter (at iba pang mahigpit na site), piliin ang **host** browser.

Kung ang agent ay naka-sandbox, ang browser tool ay default sa sandbox. Para payagan ang kontrol sa host:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Pagkatapos ay i-target ang host browser:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

O i-disable ang sandboxing para sa agent na nagpo-post ng mga update.
