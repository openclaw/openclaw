---
summary: "Installez OpenClaw et lancez votre premier chat en quelques minutes."
read_when:
  - Premiere installation a partir de zero
  - Vous voulez le chemin le plus rapide vers un chat fonctionnel
title: "Getting Started"
---

# Getting Started

Objectif : passer de zero a un premier chat fonctionnel avec une configuration minimale.

<Info>
Chat le plus rapide : ouvrez l’interface de controle (aucune configuration de canal requise). Executez `openclaw dashboard`
et discutez dans le navigateur, ou ouvrez `http://127.0.0.1:18789/` sur le
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">gateway host</Tooltip>.
Documentation : [Dashboard](/web/dashboard) et [Control UI](/web/control-ui).
</Info>

## Prerequis

- Node 22 ou plus recent

<Tip>
Verifiez votre version de Node avec `node --version` si vous n’etes pas sur.
</Tip>

## Demarrage rapide (CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    ```
    <Note>
    Autres methodes d’installation et exigences : [Install](/install).
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    L’assistant configure l’authentification, les parametres de la Gateway (passerelle) et les canaux optionnels.
    Voir [Onboarding Wizard](/start/wizard) pour plus de details.
    ```

  </Step>
  <Step title="Check the Gateway">
    Si vous avez installe le service, il devrait deja etre en cours d’execution :

    ````
    ```bash
    openclaw gateway status
    ```
    ````

  </Step>
  <Step title="Open the Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Si l’interface de controle se charge, votre Gateway est prete a l’emploi.
</Check>

## Verifications optionnelles et extras

<AccordionGroup>
  <Accordion title="Run the Gateway in the foreground">
    Utile pour des tests rapides ou le depannage.

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    Necessite un canal configure.

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## Aller plus loin

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Reference complete de l’assistant CLI et options avancees.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
    Parcours de premier lancement pour l’application macOS.
  </Card>
</Columns>

## Ce que vous aurez

- Une Gateway en cours d’execution
- L’authentification configuree
- Un acces a l’interface de controle ou un canal connecte

## Prochaines etapes

- Sécurité des DM et approbations : [Pairing](/channels/pairing)
- Connecter d’autres canaux : [Channels](/channels)
- Flux de travail avances et execution depuis les sources : [Setup](/start/setup)
