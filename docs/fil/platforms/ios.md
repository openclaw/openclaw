---
summary: "iOS node app: kumonekta sa Gateway, pairing, canvas, at pag-troubleshoot"
read_when:
  - Pag-pair o muling pagkonekta ng iOS node
  - Pagpapatakbo ng iOS app mula sa source
  - Pag-debug ng discovery ng gateway o mga command ng canvas
title: "iOS App"
---

# iOS App (Node)

Availability: internal preview. Ang iOS app ay hindi pa pampublikong ipinapamahagi.

## Ano ang ginagawa nito

- Kumokonekta sa isang Gateway sa pamamagitan ng WebSocket (LAN o tailnet).
- Inilalantad ang mga kakayahan ng node: Canvas, Screen snapshot, Camera capture, Location, Talk mode, Voice wake.
- Tumatanggap ng mga command na `node.invoke` at nag-uulat ng mga event ng status ng node.

## Mga kinakailangan

- Gateway na tumatakbo sa ibang device (macOS, Linux, o Windows sa pamamagitan ng WSL2).
- Network path:
  - Parehong LAN sa pamamagitan ng Bonjour, **o**
  - Tailnet sa pamamagitan ng unicast DNS-SD (halimbawa ng domain: `openclaw.internal.`), **o**
  - Manual host/port (fallback).

## Mabilis na pagsisimula (pair + connect)

1. Simulan ang Gateway:

```bash
openclaw gateway --port 18789
```

2. Sa iOS app, buksan ang Settings at pumili ng nadiskubreng gateway (o i-enable ang Manual Host at ilagay ang host/port).

3. Aprubahan ang pairing request sa host ng gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. I-verify ang koneksyon:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Mga path ng discovery

### Bonjour (LAN)

Ina-advertise ng Gateway ang `_openclaw-gw._tcp` sa `local.`. Awtomatikong inililista ito ng iOS app.

### Tailnet (cross-network)

Kung naka-block ang mDNS, gumamit ng unicast DNS-SD zone (pumili ng domain; halimbawa: `openclaw.internal.`) at Tailscale split DNS.
Tingnan ang [Bonjour](/gateway/bonjour) para sa halimbawa ng CoreDNS.

### Manual host/port

Sa Settings, i-enable ang **Manual Host** at ilagay ang host + port ng gateway (default `18789`).

## Canvas + A2UI

Ang iOS node ay nagre-render ng WKWebView canvas. Gamitin ang `node.invoke` para kontrolin ito:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Mga tala:

- Ang Gateway canvas host ay nagsi-serve ng `/__openclaw__/canvas/` at `/__openclaw__/a2ui/`.
- Awtomatikong nagna-navigate ang iOS node sa A2UI kapag kumokonekta kapag may na-advertise na canvas host URL.
- Bumalik sa built-in scaffold gamit ang `canvas.navigate` at `{"url":""}`.

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Voice wake + talk mode

- Available ang voice wake at talk mode sa Settings.
- Maaaring i-suspend ng iOS ang background audio; ituring ang mga voice feature bilang best-effort kapag hindi aktibo ang app.

## Mga karaniwang error

- `NODE_BACKGROUND_UNAVAILABLE`: ilagay ang iOS app sa foreground (kinakailangan ito ng mga command ng canvas/camera/screen).
- `A2UI_HOST_NOT_CONFIGURED`: hindi nag-advertise ang Gateway ng canvas host URL; suriin ang `canvasHost` sa [Gateway configuration](/gateway/configuration).
- Hindi lumalabas ang pairing prompt: patakbuhin ang `openclaw nodes pending` at manu-manong aprubahan.
- Nabigo ang muling pagkonekta pagkatapos ng reinstall: na-clear ang Keychain pairing token; i-pair muli ang node.

## Kaugnay na docs

- [Pairing](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
