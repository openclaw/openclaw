---
summary: "Manu-manong pag-login para sa browser automation + pag-post sa X/Twitter"
read_when:
  - Kailangan mong mag-log in sa mga site para sa browser automation
  - Gusto mong mag-post ng mga update sa X/Twitter
title: "Browser Login"
---

# Browser login + pag-post sa X/Twitter

## Manu-manong pag-login (inirerekomenda)

Kapag nangangailangan ng login ang isang site, **mag-sign in nang manu-mano** sa **host** na browser profile (ang OpenClaw browser).

25. **Huwag** ibigay sa modelo ang iyong mga kredensyal. 26. Ang mga automated login ay madalas mag-trigger ng anti-bot defenses at maaaring mag-lock ng account.

Bumalik sa pangunahing browser docs: [Browser](/tools/browser).

## Aling Chrome profile ang ginagamit?

27. Kinokontrol ng OpenClaw ang isang **dedikadong Chrome profile** (pinangalanang `openclaw`, may orange-tinted na UI). 28. Hiwalay ito sa iyong pang-araw-araw na browser profile.

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

29. Ang mga sandboxed na browser session ay **mas malamang** na mag-trigger ng bot detection. 30. Para sa X/Twitter (at iba pang mahihigpit na site), mas mainam ang **host** browser.

31. Kung naka-sandbox ang agent, ang browser tool ay default sa sandbox. 32. Para pahintulutan ang host control:

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
