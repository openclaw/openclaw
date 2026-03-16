---
summary: "Exécuter OpenClaw dans un conteneur Podman sans root"
read_when:
  - Vous voulez une passerelle conteneurisée avec Podman au lieu de Docker
title: "Podman"
---

# Podman

Exécutez la passerelle OpenClaw dans un conteneur Podman **sans root**. Utilise la même image que Docker (construite depuis le [Dockerfile](https://github.com/openclaw/openclaw/blob/main/Dockerfile) du dépôt).

## Prérequis

- Podman (sans root)
- Sudo pour la configuration initiale (créer l'utilisateur, construire l'image)

## Démarrage rapide

**1. Configuration initiale** (depuis la racine du dépôt ; crée l'utilisateur, construit l'image, installe le script de lancement) :

```bash
./setup-podman.sh
```

Cela crée aussi un `~openclaw/.openclaw/openclaw.json` minimal (définit `gateway.mode="local"`) pour que la passerelle puisse démarrer sans exécuter l'assistant.

Par défaut, le conteneur **n'est pas** installé comme un service systemd, vous le démarrez manuellement (voir ci-dessous). Pour une configuration de type production avec démarrage automatique et redémarrages, installez-le plutôt comme un service utilisateur systemd Quadlet :

```bash
./setup-podman.sh --quadlet
```

(Ou définissez `OPENCLAW_PODMAN_QUADLET=1` ; utilisez `--container` pour installer uniquement le conteneur et le script de lancement.)

**2. Démarrer la passerelle** (manuel, pour test rapide) :

```bash
./scripts/run-openclaw-podman.sh launch
```

**3. Assistant de configuration initiale** (par ex. pour ajouter des canaux ou fournisseurs) :

```bash
./scripts/run-openclaw-podman.sh launch setup
```

Ensuite ouvrez `http://127.0.0.1:18789/` et utilisez le jeton de `~openclaw/.openclaw/.env` (ou la valeur affichée par setup).

## Systemd (Quadlet, optionnel)

Si vous avez exécuté `./setup-podman.sh --quadlet` (ou `OPENCLAW_PODMAN_QUADLET=1`), une unité [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) est installée pour que la passerelle s'exécute comme un service utilisateur systemd pour l'utilisateur openclaw. Le service est activé et démarré à la fin de la configuration.

- **Démarrer :** `sudo systemctl --machine openclaw@ --user start openclaw.service`
- **Arrêter :** `sudo systemctl --machine openclaw@ --user stop openclaw.service`
- **État :** `sudo systemctl --machine openclaw@ --user status openclaw.service`
- **Logs :** `sudo journalctl --machine openclaw@ --user -u openclaw.service -f`

Le fichier quadlet se trouve dans `~openclaw/.config/containers/systemd/openclaw.container`. Pour changer les ports ou l'environnement, éditez ce fichier (ou le `.env` qu'il source), puis `sudo systemctl --machine openclaw@ --user daemon-reload` et redémarrez le service. Au démarrage, le service démarre automatiquement si le lingering est activé pour openclaw (la configuration fait cela quand loginctl est disponible).

Pour ajouter quadlet **après** une configuration initiale qui ne l'utilisait pas, relancez : `./setup-podman.sh --quadlet`.

## L'utilisateur openclaw (sans connexion)

`setup-podman.sh` crée un utilisateur système dédié `openclaw` :

- **Shell :** `nologin` — pas de connexion interactive ; réduit la surface d'attaque.
- **Home :** par ex. `/home/openclaw` — contient `~/.openclaw` (configuration, espace de travail) et le script de lancement `run-openclaw-podman.sh`.
- **Podman sans root :** L'utilisateur doit avoir une plage **subuid** et **subgid**. Beaucoup de distributions les assignent automatiquement à la création de l'utilisateur. Si la configuration affiche un avertissement, ajoutez des lignes à `/etc/subuid` et `/etc/subgid` :

  ```text
  openclaw:100000:65536
  ```

  Ensuite démarrez la passerelle en tant que cet utilisateur (par ex. depuis cron ou systemd) :

  ```bash
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh setup
  ```

- **Configuration :** Seuls `openclaw` et root peuvent accéder à `/home/openclaw/.openclaw`. Pour éditer la configuration : utilisez l'interface de contrôle une fois la passerelle lancée, ou `sudo -u openclaw $EDITOR /home/openclaw/.openclaw/openclaw.json`.

## Environnement et configuration

- **Jeton :** Stocké dans `~openclaw/.openclaw/.env` comme `OPENCLAW_GATEWAY_TOKEN`. `setup-podman.sh` et `run-openclaw-podman.sh` le génèrent s'il manque (utilise `openssl`, `python3`, ou `od`).
- **Optionnel :** Dans ce `.env` vous pouvez définir des clés de fournisseur (par ex. `GROQ_API_KEY`, `OLLAMA_API_KEY`) et d'autres variables d'env OpenClaw.
- **Ports hôte :** Par défaut le script mappe `18789` (passerelle) et `18790` (pont). Outrepassez le mapping de port **hôte** avec `OPENCLAW_PODMAN_GATEWAY_HOST_PORT` et `OPENCLAW_PODMAN_BRIDGE_HOST_PORT` au lancement.
- **Chemins :** La configuration hôte et l'espace de travail par défaut sont `~openclaw/.openclaw` et `~openclaw/.openclaw/workspace`. Outrepassez les chemins hôte utilisés par le script de lancement avec `OPENCLAW_CONFIG_DIR` et `OPENCLAW_WORKSPACE_DIR`.

## Commandes utiles

- **Logs :** Avec quadlet : `sudo journalctl --machine openclaw@ --user -u openclaw.service -f`. Avec script : `sudo -u openclaw podman logs -f openclaw`
- **Arrêter :** Avec quadlet : `sudo systemctl --machine openclaw@ --user stop openclaw.service`. Avec script : `sudo -u openclaw podman stop openclaw`
- **Redémarrer :** Avec quadlet : `sudo systemctl --machine openclaw@ --user start openclaw.service`. Avec script : relancez le script de lancement ou `podman start openclaw`
- **Supprimer conteneur :** `sudo -u openclaw podman rm -f openclaw` — la configuration et l'espace de travail sur l'hôte sont conservés

## Dépannage

- **Permission refusée (EACCES) sur config ou auth-profiles :** Le conteneur utilise par défaut `--userns=keep-id` et s'exécute avec le même uid/gid que l'utilisateur hôte qui lance le script. Assurez-vous que vos `OPENCLAW_CONFIG_DIR` et `OPENCLAW_WORKSPACE_DIR` hôte appartiennent à cet utilisateur.
- **Démarrage de la passerelle bloqué (manque `gateway.mode=local`) :** Assurez-vous que `~openclaw/.openclaw/openclaw.json` existe et définit `gateway.mode="local"`. `setup-podman.sh` crée ce fichier s'il manque.
- **Podman sans root échoue pour l'utilisateur openclaw :** Vérifiez que `/etc/subuid` et `/etc/subgid` contiennent une ligne pour `openclaw` (par ex. `openclaw:100000:65536`). Ajoutez-la si manquante et redémarrez.
- **Nom de conteneur utilisé :** Le script de lancement utilise `podman run --replace`, donc le conteneur existant est remplacé quand vous redémarrez. Pour nettoyer manuellement : `podman rm -f openclaw`.
- **Script non trouvé lors de l'exécution en tant qu'openclaw :** Assurez-vous que `setup-podman.sh` a été exécuté pour que `run-openclaw-podman.sh` soit copié dans le home d'openclaw (par ex. `/home/openclaw/run-openclaw-podman.sh`).
- **Service quadlet non trouvé ou ne démarre pas :** Exécutez `sudo systemctl --machine openclaw@ --user daemon-reload` après édition du fichier `.container`. Quadlet nécessite cgroups v2 : `podman info --format '{{.Host.CgroupsVersion}}'` devrait afficher `2`.

## Optionnel : exécuter en tant que votre propre utilisateur

Pour exécuter la passerelle en tant que votre utilisateur normal (pas d'utilisateur openclaw dédié) : construisez l'image, créez `~/.openclaw/.env` avec `OPENCLAW_GATEWAY_TOKEN`, et lancez le conteneur avec `--userns=keep-id` et des montages vers votre `~/.openclaw`. Le script de lancement est conçu pour le flux utilisateur-openclaw ; pour une configuration mono-utilisateur vous pouvez plutôt exécuter la commande `podman run` du script manuellement, en pointant la configuration et l'espace de travail vers votre home. Recommandé pour la plupart des utilisateurs : utilisez `setup-podman.sh` et exécutez en tant qu'utilisateur openclaw pour que la configuration et le processus soient isolés.
