---
summary: "Exécuter OpenClaw dans une VM macOS isolée (locale ou hébergée) quand vous avez besoin d'isolation ou d'iMessage"
read_when:
  - Vous voulez OpenClaw isolé de votre environnement macOS principal
  - Vous voulez l'intégration iMessage (BlueBubbles) dans un sandbox
  - Vous voulez un environnement macOS réinitialisable que vous pouvez cloner
  - Vous voulez comparer les options de VM macOS locales vs hébergées
title: "VMs macOS"
---

# OpenClaw sur VMs macOS (Isolation en sandbox)

## Configuration par défaut recommandée (la plupart des utilisateurs)

- **Petit VPS Linux** pour une passerelle toujours active et un faible coût. Voir [Hébergement VPS](/fr-FR/vps).
- **Matériel dédié** (Mac mini ou boîtier Linux) si vous voulez un contrôle total et une **IP résidentielle** pour l'automatisation de navigateur. De nombreux sites bloquent les IP de centre de données, donc la navigation locale fonctionne souvent mieux.
- **Hybride :** gardez la passerelle sur un VPS bon marché, et connectez votre Mac comme **nœud** quand vous avez besoin d'automatisation navigateur/UI. Voir [Nœuds](/fr-FR/nodes) et [Passerelle distante](/fr-FR/gateway/remote).

Utilisez une VM macOS quand vous avez spécifiquement besoin de capacités exclusives à macOS (iMessage/BlueBubbles) ou voulez une isolation stricte de votre Mac quotidien.

## Options de VM macOS

### VM locale sur votre Mac Apple Silicon (Lume)

Exécutez OpenClaw dans une VM macOS isolée sur votre Mac Apple Silicon existant en utilisant [Lume](https://cua.ai/docs/lume).

Cela vous donne :

- Environnement macOS complet en isolation (votre hôte reste propre)
- Support iMessage via BlueBubbles (impossible sur Linux/Windows)
- Réinitialisation instantanée en clonant les VMs
- Pas de matériel ou de coûts cloud supplémentaires

### Fournisseurs de Mac hébergés (cloud)

Si vous voulez macOS dans le cloud, les fournisseurs de Mac hébergés fonctionnent aussi :

- [MacStadium](https://www.macstadium.com/) (Macs hébergés)
- D'autres fournisseurs de Mac hébergés fonctionnent aussi ; suivez leurs docs VM + SSH

Une fois que vous avez un accès SSH à une VM macOS, continuez à l'étape 6 ci-dessous.

---

## Chemin rapide (Lume, utilisateurs expérimentés)

1. Installer Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Compléter l'Assistant de configuration, activer Remote Login (SSH)
4. `lume run openclaw --no-display`
5. Se connecter en SSH, installer OpenClaw, configurer les canaux
6. Terminé

---

## Ce dont vous avez besoin (Lume)

- Mac Apple Silicon (M1/M2/M3/M4)
- macOS Sequoia ou ultérieur sur l'hôte
- ~60 Go d'espace disque libre par VM
- ~20 minutes

---

## 1) Installer Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Si `~/.local/bin` n'est pas dans votre PATH :

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Vérifiez :

```bash
lume --version
```

Docs : [Installation Lume](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2) Créer la VM macOS

```bash
lume create openclaw --os macos --ipsw latest
```

Cela télécharge macOS et crée la VM. Une fenêtre VNC s'ouvre automatiquement.

Note : Le téléchargement peut prendre un certain temps selon votre connexion.

---

## 3) Compléter l'Assistant de configuration

Dans la fenêtre VNC :

1. Sélectionner la langue et la région
2. Ignorer l'identifiant Apple (ou se connecter si vous voulez iMessage plus tard)
3. Créer un compte utilisateur (mémorisez le nom d'utilisateur et le mot de passe)
4. Ignorer toutes les fonctionnalités optionnelles

Après la fin de la configuration, activez SSH :

1. Ouvrir Réglages Système → Général → Partage
2. Activer "Remote Login"

---

## 4) Obtenir l'adresse IP de la VM

```bash
lume get openclaw
```

Cherchez l'adresse IP (généralement `192.168.64.x`).

---

## 5) Se connecter en SSH à la VM

```bash
ssh youruser@192.168.64.X
```

Remplacez `youruser` par le compte que vous avez créé, et l'IP par celle de votre VM.

---

## 6) Installer OpenClaw

À l'intérieur de la VM :

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Suivez les invites de configuration initiale pour configurer votre fournisseur de modèle (Anthropic, OpenAI, etc.).

---

## 7) Configurer les canaux

Modifiez le fichier de configuration :

```bash
nano ~/.openclaw/openclaw.json
```

Ajoutez vos canaux :

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Puis connectez-vous à WhatsApp (scanner le QR) :

```bash
openclaw channels login
```

---

## 8) Exécuter la VM sans écran

Arrêtez la VM et redémarrez sans affichage :

```bash
lume stop openclaw
lume run openclaw --no-display
```

La VM s'exécute en arrière-plan. Le démon d'OpenClaw maintient la passerelle en cours d'exécution.

Pour vérifier le statut :

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bonus : intégration iMessage

C'est la fonctionnalité phare de l'exécution sur macOS. Utilisez [BlueBubbles](https://bluebubbles.app) pour ajouter iMessage à OpenClaw.

À l'intérieur de la VM :

1. Téléchargez BlueBubbles depuis bluebubbles.app
2. Connectez-vous avec votre identifiant Apple
3. Activez l'API Web et définissez un mot de passe
4. Pointez les webhooks BlueBubbles vers votre passerelle (exemple : `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Ajoutez à votre configuration OpenClaw :

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Redémarrez la passerelle. Maintenant votre agent peut envoyer et recevoir des iMessages.

Détails complets de configuration : [Canal BlueBubbles](/fr-FR/channels/bluebubbles)

---

## Sauvegarder une image dorée

Avant de personnaliser davantage, prenez un instantané de votre état propre :

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Réinitialisez à tout moment :

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Exécution 24/7

Gardez la VM en cours d'exécution en :

- Gardant votre Mac branché
- Désactivant la mise en veille dans Réglages Système → Économiseur d'énergie
- Utilisant `caffeinate` si nécessaire

Pour une véritable disponibilité permanente, envisagez un Mac mini dédié ou un petit VPS. Voir [Hébergement VPS](/fr-FR/vps).

---

## Dépannage

| Problème                                  | Solution                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Impossible de se connecter en SSH à la VM | Vérifiez que "Remote Login" est activé dans les Réglages Système de la VM                          |
| IP de la VM ne s'affiche pas              | Attendez que la VM démarre complètement, exécutez `lume get openclaw` à nouveau                    |
| Commande Lume introuvable                 | Ajoutez `~/.local/bin` à votre PATH                                                                |
| QR WhatsApp ne scanne pas                 | Assurez-vous d'être connecté à la VM (pas l'hôte) lors de l'exécution de `openclaw channels login` |

---

## Docs connexes

- [Hébergement VPS](/fr-FR/vps)
- [Nœuds](/fr-FR/nodes)
- [Passerelle distante](/fr-FR/gateway/remote)
- [Canal BlueBubbles](/fr-FR/channels/bluebubbles)
- [Démarrage rapide Lume](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Référence CLI Lume](https://cua.ai/docs/lume/reference/cli-reference)
- [Configuration VM sans surveillance](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (avancé)
- [Isolation en sandbox Docker](/fr-FR/install/docker) (approche d'isolation alternative)
