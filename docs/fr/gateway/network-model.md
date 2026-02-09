---
summary: "Comment le Gateway (passerelle), les nœuds et l’hôte du canvas se connectent."
read_when:
  - Vous voulez une vue concise du modele reseau du Gateway
title: "Modele reseau"
---

La plupart des operations transitent par le Gateway (passerelle) (`openclaw gateway`), un
processus unique et persistant qui detient les connexions de canaux et le plan de controle WebSocket.

## Regles de base

- Un Gateway (passerelle) par hote est recommande. C’est le seul processus autorise a detenir la session WhatsApp Web. Pour des bots de secours ou une isolation stricte, executez plusieurs gateways avec des profils et des ports isoles. Voir [Multiple gateways](/gateway/multiple-gateways).
- Priorite au loopback : le WS du Gateway (passerelle) est par defaut sur `ws://127.0.0.1:18789`. L’assistant genere un jeton de gateway par defaut, meme pour le loopback. Pour l’acces via tailnet, executez `openclaw gateway --bind tailnet --token ...` car des jetons sont requis pour les liaisons non loopback.
- Les nœuds se connectent au WS du Gateway (passerelle) via le LAN, le tailnet ou SSH selon les besoins. Le pont TCP legacy est obsolet.
- L’hote du canvas est un serveur de fichiers HTTP sur `canvasHost.port` (par defaut `18793`) servant `/__openclaw__/canvas/` pour les WebViews des nœuds. Voir [Gateway configuration](/gateway/configuration) (`canvasHost`).
- L’utilisation a distance se fait generalement via un tunnel SSH ou un VPN tailnet. Voir [Remote access](/gateway/remote) et [Discovery](/gateway/discovery).
