---
summary: "Panel ng Canvas na kontrolado ng agent na naka-embed sa pamamagitan ng WKWebView + custom URL scheme"
read_when:
  - Pagpapatupad ng macOS Canvas panel
  - Pagdaragdag ng mga kontrol ng agent para sa visual workspace
  - Pag-debug ng mga load ng WKWebView canvas
title: "Canvas"
---

# Canvas (macOS app)

Nag-e-embed ang macOS app ng agent‑controlled **Canvas panel** gamit ang `WKWebView`. Ito ay isang magaan na visual workspace para sa HTML/CSS/JS, A2UI, at maliliit na interactive na UI surface.

## Saan matatagpuan ang Canvas

Ang estado ng Canvas ay naka-store sa ilalim ng Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Ipinapamahagi ng Canvas panel ang mga file na iyon sa pamamagitan ng isang **custom URL scheme**:

- `openclaw-canvas://<session>/<path>`

Mga halimbawa:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Kung walang `index.html` na umiiral sa root, ipinapakita ng app ang isang **built‑in scaffold page**.

## Pag-uugali ng panel

- Walang border, nababago ang laki ng panel na naka-anchor malapit sa menu bar (o sa mouse cursor).
- Naaalala ang laki/posisyon bawat session.
- Awtomatikong nagre-reload kapag nagbago ang mga lokal na canvas file.
- Isang Canvas panel lang ang nakikita sa isang pagkakataon (pinapalitan ang session kung kinakailangan).

Maaaring i-disable ang Canvas mula sa Settings → **Allow Canvas**. Kapag naka-disable, ang mga canvas node command ay nagbabalik ng `CANVAS_DISABLED`.

## Agent API surface

Inilalantad ang Canvas sa pamamagitan ng **Gateway WebSocket**, kaya maaaring:

- ipakita/itago ang panel
- mag-navigate sa isang path o URL
- mag-evaluate ng JavaScript
- kumuha ng snapshot image

Mga halimbawa ng CLI:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Mga tala:

- Ang `canvas.navigate` ay tumatanggap ng **mga lokal na canvas path**, `http(s)` URL, at `file://` URL.
- Kung ipapasa mo ang `"/"`, ipapakita ng Canvas ang lokal na scaffold o `index.html`.

## A2UI sa Canvas

Ang A2UI ay hina-host ng Gateway canvas host at nirere-render sa loob ng Canvas panel.
Kapag nag-advertise ang Gateway ng Canvas host, awtomatikong nagna-navigate ang macOS app sa A2UI host page sa unang pagbukas.

Default na A2UI host URL:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### Mga A2UI command (v0.8)

Sa kasalukuyan, tumatanggap ang Canvas ng **A2UI v0.8** server→client messages:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

Ang `createSurface` (v0.9) ay hindi suportado.

Halimbawa ng CLI:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Mabilis na smoke test:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Pag-trigger ng agent runs mula sa Canvas

Maaaring mag-trigger ang Canvas ng mga bagong agent run sa pamamagitan ng mga deep link:

- `openclaw://agent?...`

Halimbawa (sa JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

Humihingi ang app ng kumpirmasyon maliban kung may ibinigay na valid key.

## Mga tala sa seguridad

- Hinaharangan ng Canvas scheme ang directory traversal; ang mga file ay dapat nasa ilalim ng session root.
- Ang lokal na Canvas content ay gumagamit ng custom scheme (hindi kailangan ng loopback server).
- Ang mga external na `http(s)` URL ay pinapayagan lamang kapag tahasang ini-navigate.
