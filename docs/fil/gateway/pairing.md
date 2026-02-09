---
summary: "Gateway-owned na pagpa-pair ng node (Option B) para sa iOS at iba pang remote na node"
read_when:
  - Pagpapatupad ng mga pag-apruba ng node pairing nang walang macOS UI
  - Pagdaragdag ng mga CLI flow para sa pag-apruba ng mga remote na node
  - Pagpapalawak ng gateway protocol gamit ang node management
title: "Gateway-Owned Pairing"
---

# Gateway-owned pairing (Option B)

In Gateway-owned pairing, the **Gateway** is the source of truth for which nodes
are allowed to join. UIs (macOS app, future clients) are just frontends that
approve or reject pending requests.

**Important:** WS nodes use **device pairing** (role `node`) during `connect`.
`node.pair.*` is a separate pairing store and does **not** gate the WS handshake.
Only clients that explicitly call `node.pair.*` use this flow.

## Concepts

- **Pending request**: isang node ang humiling na sumali; nangangailangan ng pag-apruba.
- **Paired node**: naaprubahang node na may inilabas na auth token.
- **Transport**: the Gateway WS endpoint forwards requests but does not decide
  membership. (Legacy TCP bridge support is deprecated/removed.)

## Paano gumagana ang pairing

1. Kumokonek ang isang node sa Gateway WS at humihiling ng pairing.
2. Ini-store ng Gateway ang isang **pending request** at nag-eemit ng `node.pair.requested`.
3. Inaaprubahan o tinatanggihan mo ang request (CLI o UI).
4. Kapag naaprubahan, nag-iisyu ang Gateway ng **bagong token** (nirorotate ang mga token sa re‑pair).
5. Muling kumokonek ang node gamit ang token at ngayon ay “paired” na.

Awtomatikong nag-e-expire ang mga pending request pagkalipas ng **5 minuto**.

## CLI workflow (headless friendly)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

Ipinapakita ng `nodes status` ang mga paired/connected na node at ang kanilang mga kakayahan.

## API surface (gateway protocol)

Events:

- `node.pair.requested` — ine-emit kapag may nalikhang bagong pending request.
- `node.pair.resolved` — ine-emit kapag ang isang request ay naaprubahan/natanggihan/nag-expire.

Methods:

- `node.pair.request` — lumikha o muling gumamit ng pending request.
- `node.pair.list` — ilista ang mga pending + paired na node.
- `node.pair.approve` — aprubahan ang isang pending request (nag-iisyu ng token).
- `node.pair.reject` — tanggihan ang isang pending request.
- `node.pair.verify` — i-verify ang `{ nodeId, token }`.

Mga tala:

- Ang `node.pair.request` ay idempotent kada node: ang mga paulit-ulit na tawag ay nagbabalik ng parehong
  pending request.
- Ang pag-apruba ay **laging** bumubuo ng bagong token; walang token na ibinabalik mula sa
  `node.pair.request`.
- Maaaring magsama ang mga request ng `silent: true` bilang pahiwatig para sa mga auto-approval flow.

## Auto-approval (macOS app)

Maaaring opsyonal na subukan ng macOS app ang isang **silent approval** kapag:

- ang request ay may markang `silent`, at
- kayang i-verify ng app ang isang SSH connection sa host ng Gateway gamit ang parehong user.

Kung mabigo ang silent approval, babalik ito sa normal na prompt na “Approve/Reject”.

## Storage (local, private)

Ang pairing state ay naka-store sa ilalim ng Gateway state directory (default `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Kung io-override mo ang `OPENCLAW_STATE_DIR`, lilipat kasama nito ang folder na `nodes/`.

Mga tala sa seguridad:

- Ang mga token ay mga lihim; ituring ang `paired.json` bilang sensitibo.
- Ang pag-rotate ng token ay nangangailangan ng muling pag-apruba (o pagbura sa entry ng node).

## Transport behavior

- Ang transport ay **stateless**; hindi ito nag-i-store ng membership.
- Kung offline ang Gateway o naka-disable ang pairing, hindi makakapag-pair ang mga node.
- Kung nasa remote mode ang Gateway, ang pairing ay nagaganap pa rin laban sa store ng remote Gateway.
