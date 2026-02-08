---
summary: "Flux de prise en main au premier lancement pour OpenClaw (application macOS)"
read_when:
  - Concevoir l’assistant de prise en main macOS
  - Mettre en œuvre l’authentification ou la configuration d’identité
title: "Prise en main (application macOS)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:52Z
---

# Prise en main (application macOS)

Ce document décrit le flux de prise en main **actuel** au premier lancement. L’objectif est une expérience fluide dès le « jour 0 » : choisir où s’exécute le Gateway (passerelle), connecter l’authentification, lancer l’assistant et laisser l’agent s’amorcer automatiquement.

<Steps>
<Step title="Approuver l’avertissement macOS">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approuver la recherche des réseaux locaux">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Bienvenue et avis de sécurité">
<Frame caption="Lisez l’avis de sécurité affiché et décidez en conséquence">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local ou distant">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Où s’exécute le **Gateway (passerelle)** ?

- **Ce Mac (local uniquement) :** la prise en main peut exécuter des flux OAuth et écrire les identifiants localement.
- **Distant (via SSH/Tailnet) :** la prise en main n’exécute **pas** OAuth en local ; les identifiants doivent exister sur l’hôte de la passerelle.
- **Configurer plus tard :** ignorer la configuration et laisser l’application non configurée.

<Tip>
**Astuce d’authentification du Gateway (passerelle) :**
- L’assistant génère désormais un **jeton** même pour le loopback, afin que les clients WS locaux doivent s’authentifier.
- Si vous désactivez l’authentification, tout processus local peut se connecter ; utilisez cette option uniquement sur des machines entièrement fiables.
- Utilisez un **jeton** pour l’accès multi‑machines ou les liaisons non‑loopback.
</Tip>
</Step>
<Step title="Autorisations">
<Frame caption="Choisissez les autorisations que vous souhaitez accorder à OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

La prise en main demande les autorisations TCC nécessaires pour :

- Automatisation (AppleScript)
- Notifications
- Accessibilité
- Enregistrement de l’écran
- Microphone
- Reconnaissance vocale
- Caméra
- Localisation

</Step>
<Step title="CLI">
  <Info>Cette étape est facultative</Info>
  L’application peut installer la CLI globale `openclaw` via npm/pnpm afin que les
  flux de travail du terminal et les tâches launchd fonctionnent immédiatement.
</Step>
<Step title="Chat de prise en main (session dédiée)">
  Après la configuration, l’application ouvre une session de chat de prise en main dédiée afin que l’agent puisse
  se présenter et guider les prochaines étapes. Cela permet de conserver l’accompagnement du premier lancement séparé
  de votre conversation habituelle. Voir [Bootstrapping](/start/bootstrapping) pour
  ce qui se passe sur l’hôte de la passerelle lors de la première exécution de l’agent.
</Step>
</Steps>
