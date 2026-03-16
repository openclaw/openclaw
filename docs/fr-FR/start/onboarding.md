---
summary: "Flux d'intégration de première exécution pour OpenClaw (application macOS)"
read_when:
  - Concevoir l'assistant d'intégration macOS
  - Implémenter la configuration d'authentification ou d'identité
title: "Intégration (application macOS)"
sidebarTitle: "Intégration : application macOS"
---

# Intégration (application macOS)

Ce document décrit le flux d'intégration de première exécution **actuel**. L'objectif est une expérience fluide du "jour 0" : choisir où la passerelle s'exécute, connecter l'authentification, exécuter l'assistant et laisser l'agent s'initialiser.
Pour une vue d'ensemble générale des chemins d'intégration, consultez [Vue d'ensemble de l'intégration](/fr-FR/start/onboarding-overview).

<Steps>
<Step title="Approuver l'avertissement macOS">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approuver la recherche de réseaux locaux">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Bienvenue et avis de sécurité">
<Frame caption="Lisez l'avis de sécurité affiché et décidez en conséquence">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs distant">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Où s'exécute la **passerelle** ?

- **Ce Mac (local uniquement) :** l'intégration peut exécuter des flux OAuth et écrire les informations d'identification localement.
- **Distant (via SSH/Tailnet) :** l'intégration n'exécute **pas** OAuth localement ; les informations d'identification doivent exister sur l'hôte de la passerelle.
- **Configurer plus tard :** ignorer la configuration et laisser l'application non configurée.

<Tip>
**Astuce d'authentification de la passerelle :**
- L'assistant génère maintenant un **token** même pour le loopback, donc les clients WS locaux doivent s'authentifier.
- Si vous désactivez l'authentification, tout processus local peut se connecter ; utilisez cela uniquement sur des machines entièrement fiables.
- Utilisez un **token** pour l'accès multi-machine ou les liaisons non-loopback.
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="Choisissez les permissions que vous souhaitez donner à OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

L'intégration demande les permissions TCC nécessaires pour :

- Automatisation (AppleScript)
- Notifications
- Accessibilité
- Enregistrement d'écran
- Microphone
- Reconnaissance vocale
- Appareil photo
- Localisation

</Step>
<Step title="CLI">
  <Info>Cette étape est optionnelle</Info>
  L'application peut installer la CLI globale `openclaw` via npm/pnpm afin que les flux de travail du terminal et les tâches launchd fonctionnent immédiatement.
</Step>
<Step title="Discussion d'intégration (session dédiée)">
  Après la configuration, l'application ouvre une session de discussion d'intégration dédiée afin que l'agent puisse se présenter et guider les prochaines étapes. Cela garde les conseils de première exécution séparés de votre conversation normale. Consultez [Initialisation](/fr-FR/start/bootstrapping) pour ce qui se passe sur l'hôte de la passerelle lors de la première exécution de l'agent.
</Step>
</Steps>
