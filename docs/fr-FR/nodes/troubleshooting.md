---
summary: "Dépannage pairing node, exigences foreground, permissions et échecs tool"
read_when:
  - Node connecté mais tools camera/canvas/screen/exec échouent
  - Vous avez besoin modèle mental pairing node versus approbations
title: "Dépannage Node"
---

# Dépannage Node

Utilisez cette page quand node visible dans status mais tools node échouent.

## Échelle commandes

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Puis exécutez checks spécifiques node :

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Signaux sains :

- Node connecté et apparié pour rôle `node`.
- `nodes describe` inclut capability que vous appelez.
- Approbations exec affichent mode/allowlist attendus.

## Exigences foreground

`canvas.*`, `camera.*` et `screen.*` sont foreground seulement sur nodes iOS/Android.

Check et fix rapides :

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Si vous voyez `NODE_BACKGROUND_UNAVAILABLE`, amenez app node au foreground et retry.

## Matrice permissions

| Capability                   | iOS                                 | Android                                      | App node macOS                 | Code échec typique             |
| ---------------------------- | ----------------------------------- | -------------------------------------------- | ------------------------------ | ------------------------------ |
| `camera.snap`, `camera.clip` | Camera (+ mic pour clip audio)      | Camera (+ mic pour clip audio)               | Camera (+ mic pour clip audio) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Screen Recording (+ mic optionnel)  | Screen capture prompt (+ mic optionnel)      | Screen Recording               | `*_PERMISSION_REQUIRED`        |
| `location.get`               | While Using ou Always (dépend mode) | Foreground/Background location basé sur mode | Permission location            | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (chemin node host)              | n/a (chemin node host)                       | Approbations exec requises     | `SYSTEM_RUN_DENIED`            |

## Pairing versus approbations

Ce sont gates différentes :

1. **Pairing device** : ce node peut-il se connecter à passerelle ?
2. **Approbations exec** : ce node peut-il exécuter commande shell spécifique ?

Checks rapides :

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Si pairing manquant, approuvez d'abord device node.
Si pairing OK mais `system.run` échoue, fixez approbations/allowlist exec.

## Codes erreur node communs

- `NODE_NOT_FOUND` : Node ID invalide ou node déconnecté
- `NODE_BACKGROUND_UNAVAILABLE` : Tool requiert foreground, app en background
- `*_PERMISSION_REQUIRED` : Permission système manquante (camera, mic, screen, location)
- `SYSTEM_RUN_DENIED` : Commande exec refusée par approbations
- `CAPABILITY_NOT_SUPPORTED` : Node ne supporte pas cette capability

## Débogage nodes iOS/Android

Activez logs verbose dans app :

**iOS :**

- Paramètres → Debug → Enable Verbose Logs

**Android :**

- Paramètres → Developer Options → Enable Verbose Logging

Puis surveillez logs passerelle :

```bash
openclaw logs --follow --grep node
```

## Réinitialiser pairing node

Si pairing corrompu :

```bash
# Côté passerelle
openclaw devices revoke --device <nodeId> --role node

# Côté app node (iOS/Android/macOS)
Paramètres → Reset Node Pairing
```

App node redemandera pairing au prochain connect.

Voir aussi :

- [Nodes](/fr-FR/nodes/index)
- [Approbations](/fr-FR/cli/approvals)
- [Devices](/fr-FR/cli/devices)
