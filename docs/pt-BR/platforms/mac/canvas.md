---
summary: "Painel Canvas controlado por agente incorporado via WKWebView + esquema de URL personalizado"
read_when:
  - Implementando o painel Canvas no macOS
  - Adicionando controles de agente para espaço de trabalho visual
  - Depurando carregamentos do canvas no WKWebView
title: "Canvas"
---

# Canvas (app macOS)

O app macOS incorpora um **painel Canvas** controlado por agente usando `WKWebView`. Ele
é um espaço de trabalho visual leve para HTML/CSS/JS, A2UI e pequenas superfícies
de UI interativas.

## Onde o Canvas fica

O estado do Canvas é armazenado em Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

O painel Canvas disponibiliza esses arquivos por meio de um **esquema de URL personalizado**:

- `openclaw-canvas://<session>/<path>`

Exemplos:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Se nenhum `index.html` existir na raiz, o app mostra uma **página de scaffold integrada**.

## Comportamento do painel

- Painel sem bordas, redimensionável, ancorado próximo à barra de menus (ou ao cursor do mouse).
- Lembra tamanho/posição por sessão.
- Recarrega automaticamente quando os arquivos locais do canvas mudam.
- Apenas um painel Canvas fica visível por vez (a sessão é alternada conforme necessário).

O Canvas pode ser desativado em Ajustes → **Permitir Canvas**. Quando desativado, os
comandos de nó do canvas retornam `CANVAS_DISABLED`.

## Superfície de API do agente

O Canvas é exposto via o **Gateway WebSocket**, então o agente pode:

- mostrar/ocultar o painel
- navegar para um caminho ou URL
- avaliar JavaScript
- capturar uma imagem instantânea

Exemplos de CLI:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Notas:

- `canvas.navigate` aceita **caminhos locais do canvas**, URLs `http(s)` e URLs `file://`.
- Se você passar `"/"`, o Canvas mostra o scaffold local ou `index.html`.

## A2UI no Canvas

O A2UI é hospedado pelo host do canvas do Gateway e renderizado dentro do painel Canvas.
Quando o Gateway anuncia um host de Canvas, o app macOS navega automaticamente para a
página do host A2UI na primeira abertura.

URL padrão do host A2UI:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### Comandos A2UI (v0.8)

Atualmente, o Canvas aceita mensagens servidor→cliente **A2UI v0.8**:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) não é suportado.

Exemplo de CLI:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Fumaça rápida:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Disparando execuções do agente a partir do Canvas

O Canvas pode disparar novas execuções do agente via deep links:

- `openclaw://agent?...`

Exemplo (em JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

O app solicita confirmação, a menos que uma chave válida seja fornecida.

## Notas de segurança

- O esquema do Canvas bloqueia travessia de diretórios; os arquivos devem ficar sob a raiz da sessão.
- O conteúdo local do Canvas usa um esquema personalizado (nenhum servidor loopback é necessário).
- URLs externas `http(s)` são permitidas apenas quando navegadas explicitamente.
