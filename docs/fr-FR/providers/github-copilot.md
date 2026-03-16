---
summary: "Connectez-vous à GitHub Copilot depuis OpenClaw en utilisant le flux d'appareil"
read_when:
  - Vous voulez utiliser GitHub Copilot comme fournisseur de modèle
  - Vous avez besoin du flux `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## Qu'est-ce que GitHub Copilot ?

GitHub Copilot est l'assistant de codage IA de GitHub. Il fournit l'accès aux modèles Copilot pour votre compte GitHub et plan. OpenClaw peut utiliser Copilot comme fournisseur de modèle de deux manières différentes.

## Deux façons d'utiliser Copilot dans OpenClaw

### 1) Fournisseur GitHub Copilot intégré (`github-copilot`)

Utilisez le flux de connexion d'appareil natif pour obtenir un token GitHub, puis échangez-le contre des tokens API Copilot quand OpenClaw s'exécute. C'est le chemin **par défaut** et le plus simple car il ne nécessite pas VS Code.

### 2) Plugin Copilot Proxy (`copilot-proxy`)

Utilisez l'extension VS Code **Copilot Proxy** comme pont local. OpenClaw parle au point de terminaison `/v1` du proxy et utilise la liste de modèles que vous y configurez. Choisissez ceci quand vous exécutez déjà Copilot Proxy dans VS Code ou devez router à travers lui.
Vous devez activer le plugin et garder l'extension VS Code en cours d'exécution.

Utilisez GitHub Copilot comme fournisseur de modèle (`github-copilot`). La commande de connexion exécute le flux d'appareil GitHub, sauvegarde un profil auth, et met à jour votre config pour utiliser ce profil.

## Configuration CLI

```bash
openclaw models auth login-github-copilot
```

Vous serez invité à visiter une URL et entrer un code unique. Gardez le terminal ouvert jusqu'à ce qu'il se termine.

### Flags optionnels

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Définir un modèle par défaut

```bash
openclaw models set github-copilot/gpt-4o
```

### Extrait de config

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Notes

- Nécessite un TTY interactif ; exécutez-le directement dans un terminal.
- La disponibilité du modèle Copilot dépend de votre plan ; si un modèle est rejeté, essayez un autre ID (par exemple `github-copilot/gpt-4.1`).
- La connexion stocke un token GitHub dans le magasin de profil auth et l'échange contre un token API Copilot quand OpenClaw s'exécute.
