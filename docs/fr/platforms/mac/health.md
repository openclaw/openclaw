---
summary: "Comment l’application macOS rapporte les états de santé de Gateway/Baileys"
read_when:
  - Débogage des indicateurs de santé de l’application macOS
title: "Contrôles de santé"
---

# Contrôles de santé sur macOS

Comment voir si le canal lié est en bonne santé depuis l’application de la barre de menus.

## Barre de menus

- Le point d’état reflète désormais la santé de Baileys :
  - Vert : lié + socket ouvert récemment.
  - Orange : connexion/nouvelle tentative.
  - Rouge : déconnecté ou échec de la sonde.
- La ligne secondaire affiche « lié · auth 12m » ou indique la raison de l’échec.
- L’élément de menu « Exécuter un contrôle de santé » déclenche une sonde à la demande.

## Réglages

- L’onglet Général ajoute une carte Santé affichant : l’âge d’authentification lié, le chemin/le nombre du magasin de session, l’heure du dernier contrôle, la dernière erreur/le code d’état, ainsi que des boutons pour Exécuter un contrôle de santé / Révéler les journaux.
- Utilise un instantané mis en cache afin que l’interface se charge instantanément et se dégrade correctement hors ligne.
- **L’onglet Canaux** expose l’état du canal + des contrôles pour WhatsApp/Telegram (QR de connexion, déconnexion, sonde, dernière déconnexion/erreur).

## Comment fonctionne la sonde

- L’application exécute `openclaw health --json` via `ShellExecutor` toutes les ~60 s et à la demande. La sonde charge les identifiants et rapporte l’état sans envoyer de messages.
- Met en cache séparément le dernier instantané valide et la dernière erreur afin d’éviter le scintillement ; affiche l’horodatage de chacun.

## En cas de doute

- Vous pouvez toujours utiliser le flux CLI dans [Santé de la Gateway](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) et suivre `/tmp/openclaw/openclaw-*.log` pour `web-heartbeat` / `web-reconnect`.
