---
summary: "Application nœud iOS : connexion à la Passerelle, appairage, canvas et dépannage"
read_when:
  - Appairage ou reconnexion du nœud iOS
  - Exécution de l'application iOS depuis les sources
  - Débogage de la découverte de passerelle ou des commandes canvas
title: "Application iOS"
---

# Application iOS (Nœud)

Disponibilité : aperçu interne. L'application iOS n'est pas encore distribuée publiquement.

## Ce qu'elle fait

- Se connecte à une Passerelle via WebSocket (LAN ou tailnet).
- Expose les capacités du nœud : Canvas, Capture d'écran, Capture caméra, Localisation, Mode vocal, Réveil vocal.
- Reçoit les commandes `node.invoke` et signale les événements de statut du nœud.

## Prérequis

- Passerelle en cours d'exécution sur un autre appareil (macOS, Linux ou Windows via WSL2).
- Chemin réseau :
  - Même LAN via Bonjour, **ou**
  - Tailnet via DNS-SD unicast (exemple de domaine : `openclaw.internal.`), **ou**
  - Hôte/port manuel (fallback).

## Démarrage rapide (appairage + connexion)

1. Démarrer la Passerelle :

```bash
openclaw gateway --port 18789
```

2. Dans l'application iOS, ouvrir Réglages et choisir une passerelle découverte (ou activer Hôte Manuel et entrer hôte/port).

3. Approuver la demande d'appairage sur l'hôte passerelle :

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Vérifier la connexion :

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Chemins de découverte

### Bonjour (LAN)

La Passerelle annonce `_openclaw-gw._tcp` sur `local.`. L'application iOS liste ces éléments automatiquement.

### Tailnet (inter-réseaux)

Si mDNS est bloqué, utilisez une zone DNS-SD unicast (choisissez un domaine ; exemple : `openclaw.internal.`) et Tailscale split DNS.
Voir [Bonjour](/fr-FR/gateway/bonjour) pour l'exemple CoreDNS.

### Hôte/port manuel

Dans Réglages, activer **Hôte Manuel** et entrer l'hôte passerelle + port (par défaut `18789`).

## Canvas + A2UI

Le nœud iOS rend un canvas WKWebView. Utilisez `node.invoke` pour le piloter :

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18789/__openclaw__/canvas/"}'
```

Remarques :

- L'hôte canvas de la Passerelle sert `/__openclaw__/canvas/` et `/__openclaw__/a2ui/`.
- Il est servi depuis le serveur HTTP de la Passerelle (même port que `gateway.port`, par défaut `18789`).
- Le nœud iOS navigue automatiquement vers A2UI lors de la connexion lorsqu'une URL d'hôte canvas est annoncée.
- Retourner au scaffold intégré avec `canvas.navigate` et `{"url":""}`.

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Réveil vocal + mode vocal

- Le réveil vocal et le mode vocal sont disponibles dans Réglages.
- iOS peut suspendre l'audio en arrière-plan ; considérez les fonctionnalités vocales comme au mieux de leurs capacités lorsque l'application n'est pas active.

## Erreurs courantes

- `NODE_BACKGROUND_UNAVAILABLE` : ramener l'application iOS au premier plan (les commandes canvas/caméra/écran le nécessitent).
- `A2UI_HOST_NOT_CONFIGURED` : la Passerelle n'a pas annoncé d'URL d'hôte canvas ; vérifier `canvasHost` dans [Configuration Passerelle](/fr-FR/gateway/configuration).
- Le prompt d'appairage n'apparaît jamais : exécuter `openclaw nodes pending` et approuver manuellement.
- La reconnexion échoue après réinstallation : le token d'appairage Keychain a été effacé ; ré-appairer le nœud.

## Documentation connexe

- [Appairage](/fr-FR/gateway/pairing)
- [Découverte](/fr-FR/gateway/discovery)
- [Bonjour](/fr-FR/gateway/bonjour)
