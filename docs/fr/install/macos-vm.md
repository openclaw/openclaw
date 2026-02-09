---
summary: "Exécutez OpenClaw dans une VM macOS en sandbox (locale ou hébergée) lorsque vous avez besoin d’isolation ou d’iMessage"
read_when:
  - Vous voulez qu’OpenClaw soit isolé de votre environnement macOS principal
  - Vous voulez une intégration iMessage (BlueBubbles) dans une sandbox
  - Vous voulez un environnement macOS réinitialisable que vous pouvez cloner
  - Vous voulez comparer les options de VM macOS locales et hébergées
title: "VM macOS"
---

# OpenClaw sur des VM macOS (Sandboxing)

## Recommandation par défaut (la plupart des utilisateurs)

- **Petit VPS Linux** pour une Gateway (passerelle) toujours active et à faible coût. Voir [VPS hosting](/vps).
- **Matériel dédié** (Mac mini ou machine Linux) si vous voulez un contrôle total et une **IP résidentielle** pour l’automatisation de navigateur. De nombreux sites bloquent les IP de centres de données, donc la navigation locale fonctionne souvent mieux.
- **Hybride :** gardez la Gateway (passerelle) sur un VPS économique et connectez votre Mac comme **nœud** lorsque vous avez besoin d’automatisation navigateur/UI. Voir [Nodes](/nodes) et [Gateway remote](/gateway/remote).

Utilisez une VM macOS lorsque vous avez spécifiquement besoin de capacités propres à macOS (iMessage/BlueBubbles) ou que vous voulez une isolation stricte par rapport à votre Mac quotidien.

## Options de VM macOS

### VM locale sur votre Mac Apple Silicon (Lume)

Exécutez OpenClaw dans une VM macOS en sandbox sur votre Mac Apple Silicon existant avec [Lume](https://cua.ai/docs/lume).

Cela vous offre :

- Un environnement macOS complet et isolé (votre hôte reste propre)
- La prise en charge d’iMessage via BlueBubbles (impossible sur Linux/Windows)
- Une réinitialisation instantanée par clonage de VM
- Aucun matériel supplémentaire ni coûts cloud

### Fournisseurs de Mac hébergés (cloud)

Si vous voulez macOS dans le cloud, les fournisseurs de Mac hébergés conviennent également :

- [MacStadium](https://www.macstadium.com/) (Mac hébergés)
- D’autres fournisseurs de Mac hébergés fonctionnent aussi ; suivez leur documentation VM + SSH

Une fois que vous avez un accès SSH à une VM macOS, poursuivez à l’étape 6 ci-dessous.

---

## Chemin rapide (Lume, utilisateurs expérimentés)

1. Installez Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Terminez l’assistant de configuration, activez la connexion à distance (SSH)
4. `lume run openclaw --no-display`
5. Connectez-vous en SSH, installez OpenClaw, configurez les canaux
6. Fait

---

## Ce dont vous avez besoin (Lume)

- Mac Apple Silicon (M1/M2/M3/M4)
- macOS Sequoia ou ultérieur sur l’hôte
- ~60 Go d’espace disque libre par VM
- ~20 minutes

---

## 1. Installer Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Si `~/.local/bin` n’est pas dans votre PATH :

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Vérifier :

```bash
lume --version
```

Docs : [Installation de Lume](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Créer la VM macOS

```bash
lume create openclaw --os macos --ipsw latest
```

Cela télécharge macOS et crée la VM. Une fenêtre VNC s’ouvre automatiquement.

Remarque : le téléchargement peut prendre un certain temps selon votre connexion.

---

## 3. Terminer l’assistant de configuration

Dans la fenêtre VNC :

1. Sélectionnez la langue et la région
2. Ignorez l’identifiant Apple (ou connectez-vous si vous voulez iMessage plus tard)
3. Créez un compte utilisateur (retenez le nom d’utilisateur et le mot de passe)
4. Ignorez toutes les fonctionnalités optionnelles

Une fois la configuration terminée, activez SSH :

1. Ouvrez Réglages Système → Général → Partage
2. Activez « Remote Login »

---

## 4. Obtenir l’adresse IP de la VM

```bash
lume get openclaw
```

Recherchez l’adresse IP (généralement `192.168.64.x`).

---

## 5. Se connecter en SSH à la VM

```bash
ssh youruser@192.168.64.X
```

Remplacez `youruser` par le compte que vous avez créé, et l’IP par celle de votre VM.

---

## 6. Installer OpenClaw

À l’intérieur de la VM :

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Suivez les invites de prise en main pour configurer votre fournisseur de modèle (Anthropic, OpenAI, etc.).

---

## 7. Configurer les canaux

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

## 8. Exécuter la VM sans interface

Arrêtez la VM et redémarrez-la sans affichage :

```bash
lume stop openclaw
lume run openclaw --no-display
```

La VM s’exécute en arrière-plan. Le démon d’OpenClaw maintient la gateway (passerelle) active.

Pour vérifier l’état :

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bonus : intégration iMessage

C’est la fonctionnalité phare de l’exécution sur macOS. Utilisez [BlueBubbles](https://bluebubbles.app) pour ajouter iMessage à OpenClaw.

À l’intérieur de la VM :

1. Téléchargez BlueBubbles depuis bluebubbles.app
2. Connectez-vous avec votre identifiant Apple
3. Activez l’API Web et définissez un mot de passe
4. Pointez les webhooks BlueBubbles vers votre gateway (passerelle) (exemple : `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

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

Redémarrez la gateway (passerelle). Votre agent peut maintenant envoyer et recevoir des iMessages.

Détails complets de configuration : [BlueBubbles channel](/channels/bluebubbles)

---

## Enregistrer une image de référence

Avant toute personnalisation supplémentaire, capturez un instantané de votre état propre :

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Réinitialiser à tout moment :

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Exécution 24/7

Gardez la VM en fonctionnement en :

- Laissant votre Mac branché
- Désactivant la mise en veille dans Réglages Système → Économiseur d’énergie
- Utilisant `caffeinate` si nécessaire

Pour un fonctionnement réellement continu, envisagez un Mac mini dédié ou un petit VPS. Voir [VPS hosting](/vps).

---

## Problemes courants

| Problème                                  | Solution                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Impossible de se connecter en SSH à la VM | Vérifiez que « Remote Login » est activé dans les Réglages Système de la VM                                                     |
| IP de la VM non affichée                  | Attendez que la VM ait complètement démarré, relancez `lume get openclaw` à nouveau                                             |
| Commande Lume introuvable                 | Ajoutez `~/.local/bin` à votre PATH                                                                                             |
| QR WhatsApp ne se scanne pas              | Assurez-vous d’être connecté dans la VM (et non sur l’hôte) lors de l’exécution de `openclaw channels login` |

---

## Documentation associée

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (avancé)
- [Docker Sandboxing](/install/docker) (approche alternative d’isolation)
