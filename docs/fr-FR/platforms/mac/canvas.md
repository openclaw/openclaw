---
summary: "Panneau Canvas contrôlé agent embarqué via WKWebView + schéma URL personnalisé"
read_when:
  - Implémentation panneau Canvas macOS
  - Ajout contrôles agent pour workspace visuel
  - Débogage chargements canvas WKWebView
title: "Canvas"
---

# Canvas (app macOS)

L'app macOS embarque un **panneau Canvas** contrôlé agent utilisant `WKWebView`. C'est un workspace visuel léger pour HTML/CSS/JS, A2UI et petites surfaces UI interactives.

## Où vit Canvas

L'état Canvas est stocké sous Application Support :

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Le panneau Canvas sert ces fichiers via **schéma URL personnalisé** :

- `openclaw-canvas://<session>/<path>`

Exemples :

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Si aucun `index.html` n'existe à la racine, l'app montre une **page scaffold built-in**.

## Comportement Panneau

- Panneau borderless, redimensionnable ancré près menu bar (ou curseur souris).
- Se souvient taille/position par session.
- Auto-reload quand fichiers canvas locaux changent.
- Un seul panneau Canvas visible à la fois (session switchée au besoin).

Canvas peut être désactivé depuis Réglages → **Allow Canvas**. Quand désactivé, commandes nœud canvas retournent `CANVAS_DISABLED`.

## Surface API Agent

Canvas est exposé via **WebSocket Passerelle**, donc l'agent peut :

- show/hide le panneau
- naviguer vers chemin ou URL
- évaluer JavaScript
- capturer image snapshot

Exemples CLI :

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Voir aussi :

- [Nœuds](/fr-FR/nodes/index)
- [Passerelle Bundled](/fr-FR/platforms/mac/bundled-gateway)
- [App macOS](/fr-FR/platforms/macos)
