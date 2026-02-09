---
summary: "Sanggunian ng CLI para sa `openclaw browser` (mga profile, tab, aksyon, relay ng extension)"
read_when:
  - Gumagamit ka ng `openclaw browser` at gusto mo ng mga halimbawa para sa mga karaniwang gawain
  - Gusto mong kontrolin ang browser na tumatakbo sa ibang makina sa pamamagitan ng host ng node
  - Gusto mong gamitin ang relay ng Chrome extension (attach/detach sa pamamagitan ng toolbar button)
title: "browser"
---

# `openclaw browser`

Pamahalaan ang browser control server ng OpenClaw at magpatakbo ng mga aksyon sa browser (mga tab, snapshot, screenshot, pag-navigate, mga click, pagta-type).

Kaugnay:

- Browser tool + API: [Browser tool](/tools/browser)
- Relay ng Chrome extension: [Chrome extension](/tools/chrome-extension)

## Mga karaniwang flag

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (default mula sa config).
- `--token <token>`: Gateway token (kung kinakailangan).
- `--timeout <ms>`: timeout ng request (ms).
- `--browser-profile <name>`: pumili ng browser profile (default mula sa config).
- `--json`: machine-readable na output (kung sinusuportahan).

## Mabilis na pagsisimula (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Mga profile

31. Ang mga profile ay pinangalanang browser routing config. 32. Sa praktika:

- `openclaw`: nagla-launch/nag-a-attach sa isang dedikadong Chrome instance na pinamamahalaan ng OpenClaw (hiwalay na user data dir).
- `chrome`: kinokontrol ang iyong umiiral na Chrome tab(s) sa pamamagitan ng relay ng Chrome extension.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Gumamit ng partikular na profile:

```bash
openclaw browser --browser-profile work tabs
```

## Mga tab

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / screenshot / mga aksyon

Snapshot:

```bash
openclaw browser snapshot
```

Screenshot:

```bash
openclaw browser screenshot
```

Mag-navigate/mag-click/mag-type (ref-based na UI automation):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Relay ng Chrome extension (attach sa pamamagitan ng toolbar button)

Pinapahintulutan ng mode na ito ang agent na kontrolin ang isang umiiral na Chrome tab na manu-mano mong ina-attach (hindi ito auto-attach).

I-install ang unpacked extension sa isang stable na path:

```bash
openclaw browser extension install
openclaw browser extension path
```

Pagkatapos, Chrome → `chrome://extensions` → i-enable ang “Developer mode” → “Load unpacked” → piliin ang na-print na folder.

Buong gabay: [Chrome extension](/tools/chrome-extension)

## Remote na kontrol ng browser (proxy ng host ng node)

33. Kung ang Gateway ay tumatakbo sa ibang makina kaysa sa browser, magpatakbo ng isang **node host** sa makinang may Chrome/Brave/Edge/Chromium. 34. Ipo-proxy ng Gateway ang mga aksyon ng browser patungo sa node na iyon (walang hiwalay na browser control server na kailangan).

Gamitin ang `gateway.nodes.browser.mode` para kontrolin ang auto-routing at ang `gateway.nodes.browser.node` para i-pin ang isang partikular na node kung marami ang nakakonekta.

Seguridad + remote na setup: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
