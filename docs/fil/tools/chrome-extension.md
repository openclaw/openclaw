---
summary: "Chrome extension: hayaan ang OpenClaw na kontrolin ang iyong umiiral na Chrome tab"
read_when:
  - Gusto mong patakbuhin ng agent ang isang umiiral na Chrome tab (toolbar button)
  - Kailangan mo ng remote Gateway + lokal na browser automation sa pamamagitan ng Tailscale
  - Gusto mong maunawaan ang mga implikasyon sa seguridad ng pag-takeover ng browser
title: "Chrome Extension"
x-i18n:
  source_path: tools/chrome-extension.md
  source_hash: 3b77bdad7d3dab6a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:08Z
---

# Chrome extension (browser relay)

Pinapahintulutan ng OpenClaw Chrome extension ang agent na kontrolin ang iyong **umiiral na mga Chrome tab** (ang iyong normal na Chrome window) sa halip na maglunsad ng hiwalay na Chrome profile na pinamamahalaan ng openclaw.

Ang attach/detach ay ginagawa sa pamamagitan ng **iisang Chrome toolbar button**.

## Ano ito (konsepto)

May tatlong bahagi:

- **Browser control service** (Gateway o node): ang API na tinatawag ng agent/tool (sa pamamagitan ng Gateway)
- **Local relay server** (loopback CDP): nagbabridge sa pagitan ng control server at ng extension (`http://127.0.0.1:18792` bilang default)
- **Chrome MV3 extension**: kumakabit sa aktibong tab gamit ang `chrome.debugger` at ipinapasa ang mga CDP message sa relay

Pagkatapos, kinokontrol ng OpenClaw ang nakakabit na tab sa pamamagitan ng normal na `browser` tool surface (pinipili ang tamang profile).

## I-install / i-load (unpacked)

1. I-install ang extension sa isang stable na lokal na path:

```bash
openclaw browser extension install
```

2. I-print ang path ng naka-install na extension directory:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- I-enable ang “Developer mode”
- “Load unpacked” → piliin ang directory na na-print sa itaas

4. I-pin ang extension.

## Mga update (walang build step)

Kasama ang extension sa OpenClaw release (npm package) bilang mga static file. Walang hiwalay na “build” step.

Pagkatapos mag-upgrade ng OpenClaw:

- I-run muli ang `openclaw browser extension install` para i-refresh ang mga naka-install na file sa ilalim ng iyong OpenClaw state directory.
- Chrome → `chrome://extensions` → i-click ang “Reload” sa extension.

## Paggamit (walang dagdag na config)

May kasamang built-in browser profile ang OpenClaw na pinangalanang `chrome` na naka-target sa extension relay sa default na port.

Gamitin ito:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agent tool: `browser` gamit ang `profile="chrome"`

Kung gusto mo ng ibang pangalan o ibang relay port, gumawa ng sarili mong profile:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Attach / detach (toolbar button)

- Buksan ang tab na gusto mong kontrolin ng OpenClaw.
- I-click ang icon ng extension.
  - Ipapakita ng badge ang `ON` kapag naka-attach.
- I-click muli para mag-detach.

## Aling tab ang kinokontrol nito?

- **Hindi** nito awtomatikong kinokontrol ang “kahit anong tab na tinitingnan mo”.
- Kinokontrol nito **lamang ang tab o mga tab na tahasan mong in-attach** sa pamamagitan ng pag-click sa toolbar button.
- Para magpalit: buksan ang ibang tab at i-click ang extension icon doon.

## Badge + karaniwang mga error

- `ON`: naka-attach; kayang patakbuhin ng OpenClaw ang tab na iyon.
- `…`: kumokonekta sa lokal na relay.
- `!`: hindi maabot ang relay (pinakakaraniwan: hindi tumatakbo ang browser relay server sa makinang ito).

Kung makita mo ang `!`:

- Siguraduhing tumatakbo ang Gateway nang lokal (default na setup), o magpatakbo ng host ng node sa makinang ito kung nasa ibang lugar tumatakbo ang Gateway.
- Buksan ang Options page ng extension; ipinapakita nito kung maaabot ang relay.

## Remote Gateway (gumamit ng host ng node)

### Lokal na Gateway (kaparehong makina ng Chrome) — kadalasan **walang dagdag na hakbang**

Kung tumatakbo ang Gateway sa parehong makina ng Chrome, sinisimulan nito ang browser control service sa loopback
at awtomatikong sinisimulan ang relay server. Nakikipag-usap ang extension sa lokal na relay; ang mga tawag ng CLI/tool ay papunta sa Gateway.

### Remote Gateway (tumatakbo ang Gateway sa ibang lugar) — **magpatakbo ng host ng node**

Kung tumatakbo ang iyong Gateway sa ibang makina, magsimula ng host ng node sa makinang nagpapatakbo ng Chrome.
Ipo-proxy ng Gateway ang mga aksyon ng browser papunta sa node na iyon; mananatiling lokal sa makinang may browser ang extension + relay.

Kung maraming node ang nakakonekta, i-pin ang isa gamit ang `gateway.nodes.browser.node` o itakda ang `gateway.nodes.browser.mode`.

## Sandboxing (tool containers)

Kung ang iyong agent session ay sandboxed (`agents.defaults.sandbox.mode != "off"`), maaaring higpitan ang `browser` tool:

- Bilang default, ang mga sandboxed session ay madalas na naka-target sa **sandbox browser** (`target="sandbox"`), hindi sa iyong host Chrome.
- Ang Chrome extension relay takeover ay nangangailangan ng pagkontrol sa **host** browser control server.

Mga opsyon:

- Pinakamadali: gamitin ang extension mula sa isang **non-sandboxed** na session/agent.
- O pahintulutan ang host browser control para sa mga sandboxed session:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Pagkatapos, tiyaking hindi tinatanggihan ng tool policy ang tool, at (kung kinakailangan) tawagin ang `browser` gamit ang `target="host"`.

Pag-debug: `openclaw sandbox explain`

## Mga tip sa remote access

- Panatilihin ang Gateway at host ng node sa iisang tailnet; iwasang ilantad ang mga relay port sa LAN o pampublikong Internet.
- I-pair ang mga node nang may intensyon; i-disable ang browser proxy routing kung ayaw mo ng remote control (`gateway.nodes.browser.mode="off"`).

## Paano gumagana ang “extension path”

Ipi-print ng `openclaw browser extension path` ang **naka-install** na on-disk directory na naglalaman ng mga file ng extension.

Sinasadya ng CLI na **hindi** mag-print ng `node_modules` path. Palaging patakbuhin muna ang `openclaw browser extension install` para kopyahin ang extension sa isang stable na lokasyon sa ilalim ng iyong OpenClaw state directory.

Kung ililipat o buburahin mo ang install directory na iyon, mamarkahan ng Chrome ang extension bilang sira hanggang sa i-reload mo ito mula sa isang valid na path.

## Mga implikasyon sa seguridad (basahin ito)

Makapangyarihan at mapanganib ito. Ituring ito na parang binibigyan mo ang model ng “mga kamay sa iyong browser”.

- Ginagamit ng extension ang debugger API ng Chrome (`chrome.debugger`). Kapag naka-attach, kaya ng model na:
  - mag-click/mag-type/mag-navigate sa tab na iyon
  - magbasa ng nilalaman ng page
  - mag-access ng kahit ano na maa-access ng naka-log-in na session ng tab
- **Hindi ito isolated** tulad ng dedikadong openclaw-managed profile.
  - Kung mag-a-attach ka sa iyong pang-araw-araw na profile/tab, nagbibigay ka ng access sa state ng account na iyon.

Mga rekomendasyon:

- Mas mainam ang dedikadong Chrome profile (hiwalay sa iyong personal na pagba-browse) para sa paggamit ng extension relay.
- Panatilihing tailnet-only ang Gateway at anumang host ng node; umasa sa Gateway auth + node pairing.
- Iwasang ilantad ang mga relay port sa LAN (`0.0.0.0`) at iwasan ang Funnel (public).
- Hinaharangan ng relay ang mga non-extension origin at nangangailangan ng internal auth token para sa mga CDP client.

Kaugnay:

- Pangkalahatang-ideya ng Browser tool: [Browser](/tools/browser)
- Security audit: [Security](/gateway/security)
- Setup ng Tailscale: [Tailscale](/gateway/tailscale)
