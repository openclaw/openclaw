---
summary: "Comment la Passerelle, les nœuds et l'hôte canvas se connectent."
read_when:
  - Vous voulez une vue concise du modèle réseau de la Passerelle
title: "Modèle réseau"
---

La plupart des opérations transitent par la Passerelle (`openclaw gateway`), un processus unique de longue durée qui possède les connexions canal et le plan de contrôle WebSocket.

## Règles de base

- Une Passerelle par hôte est recommandée. C'est le seul processus autorisé à posséder la session WhatsApp Web. Pour les bots de secours ou l'isolation stricte, exécutez plusieurs passerelles avec des profils isolés et des ports différents. Voir [Passerelles multiples](/fr-FR/gateway/multiple-gateways).
- Loopback d'abord : le WS de la Passerelle utilise par défaut `ws://127.0.0.1:18789`. L'assistant génère un token de passerelle par défaut, même pour loopback. Pour l'accès tailnet, exécutez `openclaw gateway --bind tailnet --token ...` car les tokens sont requis pour les liaisons non-loopback.
- Les nœuds se connectent au WS de la Passerelle via LAN, tailnet ou SSH selon les besoins. Le pont TCP hérité est déprécié.
- L'hôte canvas est servi par le serveur HTTP de la Passerelle sur le **même port** que la Passerelle (par défaut `18789`) :
  - `/__openclaw__/canvas/`
  - `/__openclaw__/a2ui/`
    Lorsque `gateway.auth` est configuré et que la Passerelle se lie au-delà de loopback, ces routes sont protégées par l'auth Passerelle (les requêtes loopback sont exemptées). Voir [Configuration de la Passerelle](/fr-FR/gateway/configuration) (`canvasHost`, `gateway`).
- L'utilisation distante se fait typiquement via tunnel SSH ou VPN tailnet. Voir [Accès distant](/fr-FR/gateway/remote) et [Découverte](/fr-FR/gateway/discovery).
