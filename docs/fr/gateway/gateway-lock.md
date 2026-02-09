---
summary: "Garde de singleton de la Gateway utilisant la liaison de l’écouteur WebSocket"
read_when:
  - Exécution ou débogage du processus de la Gateway
  - Investigation de l’application d’une instance unique
title: "Verrou de la Gateway"
---

# Verrou de la Gateway

Dernière mise à jour : 2025-12-11

## Pourquoi

- Garantir qu’une seule instance de la Gateway (passerelle) s’exécute par port de base sur le même hôte ; des Gateways supplémentaires doivent utiliser des profils isolés et des ports uniques.
- Survivre aux crashs/SIGKILL sans laisser de fichiers de verrou obsolètes.
- Échouer rapidement avec une erreur explicite lorsque le port de contrôle est déjà occupé.

## Mécanisme

- La Gateway (passerelle) lie l’écouteur WebSocket (par défaut `ws://127.0.0.1:18789`) immédiatement au démarrage à l’aide d’un écouteur TCP exclusif.
- Si la liaison échoue avec `EADDRINUSE`, le démarrage lève `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Le système d’exploitation libère automatiquement l’écouteur à toute fin de processus, y compris en cas de crash et de SIGKILL — aucun fichier de verrou distinct ni étape de nettoyage n’est nécessaire.
- À l’arrêt, la Gateway (passerelle) ferme le serveur WebSocket et le serveur HTTP sous-jacent afin de libérer rapidement le port.

## Surface d’erreur

- Si un autre processus détient le port, le démarrage lève `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Les autres échecs de liaison remontent sous `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## Notes opérationnelles

- Si le port est occupé par _un autre_ processus, l’erreur est identique ; libérez le port ou choisissez-en un autre avec `openclaw gateway --port <port>`.
- L’application macOS maintient toujours sa propre garde PID légère avant de lancer la Gateway (passerelle) ; le verrouillage à l’exécution est appliqué par la liaison WebSocket.
