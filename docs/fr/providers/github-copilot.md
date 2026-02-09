---
summary: "Se connecter à GitHub Copilot depuis OpenClaw en utilisant le device flow"
read_when:
  - Vous souhaitez utiliser GitHub Copilot comme fournisseur de modèles
  - Vous avez besoin du flux `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## Qu’est-ce que GitHub Copilot ?

GitHub Copilot est l’assistant de codage IA de GitHub. Il fournit l’accès aux
modèles Copilot pour votre compte et votre offre GitHub. OpenClaw peut utiliser
Copilot comme fournisseur de modèles de deux manières différentes.

## Deux façons d’utiliser Copilot dans OpenClaw

### 1. Fournisseur GitHub Copilot intégré (`github-copilot`)

Utilisez le flux de connexion natif par appareil pour obtenir un jeton GitHub,
puis l’échanger contre des jetons d’API Copilot lorsque OpenClaw s’exécute. C’est
le chemin **par défaut** et le plus simple, car il ne nécessite pas VS Code.

### 2. Plugin Copilot Proxy (`copilot-proxy`)

Utilisez l’extension VS Code **Copilot Proxy** comme passerelle locale. OpenClaw
communique avec le point de terminaison `/v1` du proxy et utilise la
liste de modèles que vous y configurez. Choisissez cette option si vous utilisez
déjà Copilot Proxy dans VS Code ou si vous devez faire transiter le trafic par
celui-ci.
Vous devez activer le plugin et maintenir l’extension VS Code en cours
d’exécution.

Utilisez GitHub Copilot comme fournisseur de modèles (`github-copilot`). La
commande de connexion exécute le device flow GitHub, enregistre un profil
d’authentification et met à jour votre configuration pour utiliser ce profil.

## Configuration CLI

```bash
openclaw models auth login-github-copilot
```

Vous serez invité à visiter une URL et à saisir un code à usage unique. Gardez le
terminal ouvert jusqu’à la fin de l’opération.

### Options facultatives

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Définir un modèle par défaut

```bash
openclaw models set github-copilot/gpt-4o
```

### Extrait de configuration

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Notes

- Nécessite un TTY interactif ; exécutez la commande directement dans un terminal.
- La disponibilité des modèles Copilot dépend de votre offre ; si un modèle est
  refusé, essayez un autre identifiant (par exemple `github-copilot/gpt-4.1`).
- La connexion stocke un jeton GitHub dans le magasin de profils
  d’authentification et l’échange contre un jeton d’API Copilot lorsque OpenClaw
  s’exécute.
