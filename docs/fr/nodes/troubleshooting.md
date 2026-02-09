---
summary: "Dépannage de l’appairage des nœuds, des exigences de premier plan, des autorisations et des échecs d’outils"
read_when:
  - Le nœud est connecté mais les outils caméra/canvas/écran/exec échouent
  - Vous avez besoin du modèle mental appairage des nœuds versus approbations
title: "Dépannage des nœuds"
---

# nodes/troubleshooting.md

Utilisez cette page lorsqu’un nœud est visible dans l’état mais que les outils du nœud échouent.

## Échelle de commandes

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Ensuite, exécutez des vérifications spécifiques au nœud :

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Signaux sains :

- Le nœud est connecté et appairé pour le rôle `node`.
- `nodes describe` inclut la capacité que vous appelez.
- Les approbations exec affichent le mode/la liste d’autorisation attendus.

## Exigences de premier plan

`canvas.*`, `camera.*` et `screen.*` sont uniquement disponibles au premier plan sur les nœuds iOS/Android.

Vérification et correction rapides :

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Si vous voyez `NODE_BACKGROUND_UNAVAILABLE`, ramenez l’app du nœud au premier plan et réessayez.

## Matrice des autorisations

| Capacité                     | iOS                                                                  | Android                                                           | App de nœud macOS                                          | Code d’échec typique           |
| ---------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Caméra (+ micro pour l’audio des clips)           | Caméra (+ micro pour l’audio des clips)        | Caméra (+ micro pour l’audio des clips) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Enregistrement de l’écran (+ micro facultatif)    | Invite de capture d’écran (+ micro facultatif) | Enregistrement de l’écran                                  | `*_PERMISSION_REQUIRED`        |
| `location.get`               | Lors de l’utilisation ou Toujours (selon le mode) | Localisation au premier plan/en arrière-plan selon le mode        | Autorisation de localisation                               | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (chemin de l’hôte du nœud)                    | n/a (chemin de l’hôte du nœud)                 | Approbations exec requises                                 | `SYSTEM_RUN_DENIED`            |

## Appairage versus approbations

Il s’agit de verrous différents :

1. **Appairage de l’appareil** : ce nœud peut-il se connecter à la Gateway (passerelle) ?
2. **Approbations exec** : ce nœud peut-il exécuter une commande shell spécifique ?

Vérifications rapides :

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Si l’appairage est manquant, approuvez d’abord l’appareil du nœud.
Si l’appairage est correct mais que `system.run` échoue, corrigez les approbations exec/la liste d’autorisation.

## Codes d’erreur courants des nœuds

- `NODE_BACKGROUND_UNAVAILABLE` → l’app est en arrière-plan ; mettez-la au premier plan.
- `CAMERA_DISABLED` → le basculement de la caméra est désactivé dans les paramètres du nœud.
- `*_PERMISSION_REQUIRED` → autorisation du système d’exploitation manquante/refusée.
- `LOCATION_DISABLED` → le mode de localisation est désactivé.
- `LOCATION_PERMISSION_REQUIRED` → le mode de localisation demandé n’est pas accordé.
- `LOCATION_BACKGROUND_UNAVAILABLE` → l’app est en arrière-plan mais seule l’autorisation « Lors de l’utilisation » existe.
- `SYSTEM_RUN_DENIED: approval required` → la requête exec nécessite une approbation explicite.
- `SYSTEM_RUN_DENIED: allowlist miss` → la commande est bloquée par le mode de liste d’autorisation.

## Boucle de récupération rapide

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Si le problème persiste :

- Réapprouvez l’appairage de l’appareil.
- Ré-ouvrir l'application du nœud (au premier plan).
- Réaccordez les autorisations du système d’exploitation.
- Recréez/ajustez la politique d’approbation exec.

Liens connexes :

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
