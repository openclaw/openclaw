---
summary: "Agentstyret Canvas-panel indlejret via WKWebView + brugerdefineret URL-skema"
read_when:
  - Implementering af macOS Canvas-panelet
  - Tilføjelse af agentkontroller til visuelt arbejdsområde
  - Fejlfinding af indlæsning af WKWebView Canvas
title: "Canvas"
---

# Canvas (macOS-app)

macOS app'en integrerer en agentkontrolleret **Canvas panel** ved hjælp af `WKWebView`. Det
er et letvægts visuelt arbejdsområde for HTML/CSS/JS, A2UI og små interaktive
UI-overflader.

## Hvor Canvas ligger

Canvas-tilstand gemmes under Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas-panelet serverer disse filer via et **brugerdefineret URL-skema**:

- `openclaw-canvas://<session>/<path>`

Eksempler:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Hvis der ikke findes en `index.html` i roden, viser appen en **indbygget scaffold-side**.

## Paneladfærd

- Kantløst panel med mulighed for størrelsesændring, forankret nær menulinjen (eller musemarkøren).
- Husker størrelse/position pr. session.
- Genindlæses automatisk, når lokale Canvas-filer ændres.
- Kun ét Canvas-panel er synligt ad gangen (sessionen skiftes efter behov).

Lærred kan deaktiveres fra Indstillinger → **Tillad Lærer**. Når deaktiveret, returnerer canvas
node kommandoer `CANVAS_DISABLED`.

## Agent API-overflade

Canvas eksponeres via **Gateway WebSocket**, så agenten kan:

- vise/skjule panelet
- navigere til en sti eller URL
- evaluere JavaScript
- optage et snapshot-billede

CLI-eksempler:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Noter:

- `canvas.navigate` accepterer **lokale Canvas-stier**, `http(s)`-URL’er og `file://`-URL’er.
- Hvis du angiver `"/"`, viser Canvas den lokale scaffold eller `index.html`.

## A2UI i Canvas

A2UI er vært for Gateway lærred værten og gengives inde i lærred panelet.
Når Gateway reklamerer for en lærreds-vært, vil macOS-appen automatisk navigere til
A2UI-værtssiden på første åbne.

Standard A2UI-host-URL:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI-kommandoer (v0.8)

Canvas accepterer i øjeblikket **A2UI v0.8** server→klient-beskeder:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) understøttes ikke.

CLI-eksempel:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Hurtig smoke-test:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Udløsning af agentkørsler fra Canvas

Canvas kan udløse nye agentkørsler via deep links:

- `openclaw://agent?...`

Eksempel (i JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

Appen beder om bekræftelse, medmindre der er angivet en gyldig nøgle.

## Sikkerhedsnoter

- Canvas-skemaet blokerer directory traversal; filer skal ligge under sessionsroden.
- Lokalt Canvas-indhold bruger et brugerdefineret skema (ingen loopback-server påkrævet).
- Eksterne `http(s)`-URL’er er kun tilladt, når der navigeres eksplicit.
