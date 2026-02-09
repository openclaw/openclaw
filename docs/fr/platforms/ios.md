---
summary: "Application de nœud iOS : connexion à la Gateway, appairage, canvas et dépannage"
read_when:
  - Appairage ou reconnexion du nœud iOS
  - Exécution de l’application iOS depuis les sources
  - Débogage de la découverte de la Gateway ou des commandes canvas
title: "Application iOS"
---

# Application iOS (Nœud)

Disponibilité : aperçu interne. L’application iOS n’est pas encore distribuée publiquement.

## Ce qu’elle fait

- Se connecte à une Gateway via WebSocket (LAN ou tailnet).
- Expose les capacités du nœud : Canvas, capture d’écran, capture caméra, localisation, mode conversation, réveil vocal.
- Reçoit les commandes `node.invoke` et rapporte les événements d’état du nœud.

## Exigences

- Gateway exécutée sur un autre appareil (macOS, Linux ou Windows via WSL2).
- Chemin réseau :
  - Même LAN via Bonjour, **ou**
  - Tailnet via DNS-SD unicast (domaine d’exemple : `openclaw.internal.`), **ou**
  - Hôte/port manuel (solution de secours).

## Démarrage rapide (appairer + connecter)

1. Démarrez la Gateway :

```bash
openclaw gateway --port 18789
```

2. Dans l’application iOS, ouvrez Réglages et choisissez une Gateway découverte (ou activez Hôte manuel et saisissez l’hôte/le port).

3. Approuvez la demande d’appairage sur l’hôte de la Gateway :

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Vérifiez la connexion :

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Chemins de découverte

### Bonjour (LAN)

La Gateway annonce `_openclaw-gw._tcp` sur `local.`. L’application iOS les répertorie automatiquement.

### Tailnet (inter-réseaux)

Si mDNS est bloqué, utilisez une zone DNS-SD unicast (choisissez un domaine ; exemple : `openclaw.internal.`) et le split DNS de Tailscale.
Voir [Bonjour](/gateway/bonjour) pour l’exemple CoreDNS.

### Hôte/port manuel

Dans Réglages, activez **Hôte manuel** et saisissez l’hôte + le port de la Gateway (par défaut `18789`).

## Canvas + A2UI

Le nœud iOS rend un canvas WKWebView. Utilisez `node.invoke` pour le piloter :

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Remarques :

- L’hôte canvas de la Gateway sert `/__openclaw__/canvas/` et `/__openclaw__/a2ui/`.
- Le nœud iOS navigue automatiquement vers A2UI à la connexion lorsqu’une URL d’hôte canvas est annoncée.
- Revenez à l’échafaudage intégré avec `canvas.navigate` et `{"url":""}`.

### Évaluation du canvas / instantané

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Réveil vocal + mode conversation

- Le réveil vocal et le mode conversation sont disponibles dans Réglages.
- iOS peut suspendre l’audio en arrière-plan ; considérez les fonctionnalités vocales comme « best-effort » lorsque l’application n’est pas active.

## Erreurs courantes

- `NODE_BACKGROUND_UNAVAILABLE` : amenez l’application iOS au premier plan (les commandes canvas/caméra/écran l’exigent).
- `A2UI_HOST_NOT_CONFIGURED` : la Gateway n’a pas annoncé d’URL d’hôte canvas ; vérifiez `canvasHost` dans la [configuration de la Gateway](/gateway/configuration).
- L’invite d’appairage n’apparaît jamais : exécutez `openclaw nodes pending` et approuvez manuellement.
- La reconnexion échoue après réinstallation : le jeton d’appairage du Trousseau a été effacé ; ré-appairez le nœud.

## Documentation associée

- [Appairage](/gateway/pairing)
- [Découverte](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
