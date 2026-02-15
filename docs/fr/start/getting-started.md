---
summary: "Installez OpenClaw et lancez votre premier chat en quelques minutes."
read_when:
  - Première installation à partir de zéro
  - Vous voulez le chemin le plus rapide vers un chat fonctionnel
title: "Premiers pas"
---

# Premiers pas

Objectif : passer de zéro à un premier chat fonctionnel avec une configuration minimale.

<Info>
Chat le plus rapide : ouvrez l'UI de Contrôle (pas de configuration de canal nécessaire). Lancez `openclaw dashboard`
et chattez dans le navigateur, ou ouvrez `http://127.0.0.1:18789/` sur l'
<Tooltip headline="Hôte Gateway" tip="La machine exécutant le service gateway OpenClaw.">hôte gateway</Tooltip>.
Docs : [Tableau de bord](/web/dashboard) et [UI de Contrôle](/web/control-ui).
</Info>

## Prérequis

- Node 22 ou plus récent

<Tip>
Vérifiez votre version de Node avec `node --version` si vous n'êtes pas sûr.
</Tip>

## Configuration rapide (CLI)

<Steps>
  <Step title="Installer OpenClaw (recommandé)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="Processus Script d'Installation"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Autres méthodes d'installation et prérequis : [Installation](/install).
    </Note>

  </Step>
  <Step title="Lancer l'assistant d'onboarding">
    ```bash
    openclaw onboard --install-daemon
    ```

    L'assistant configure l'auth, les paramètres gateway et les canaux optionnels.
    Voir [Assistant d'Onboarding](/start/wizard) pour les détails.

  </Step>
  <Step title="Vérifier la Gateway">
    Si vous avez installé le service, il devrait déjà être en cours d'exécution :

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Ouvrir l'UI de Contrôle">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Si l'UI de Contrôle se charge, votre Gateway est prête à l'emploi.
</Check>

## Vérifications optionnelles et extras

<AccordionGroup>
  <Accordion title="Lancer la Gateway au premier plan">
    Utile pour des tests rapides ou le dépannage.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Envoyer un message de test">
    Nécessite un canal configuré.

    ```bash
    openclaw message send --target +15555550123 --message "Bonjour depuis OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Variables d'environnement utiles

Si vous exécutez OpenClaw en tant que compte de service ou voulez des emplacements de config/état personnalisés :

- `OPENCLAW_HOME` définit le répertoire home utilisé pour la résolution de chemin interne.
- `OPENCLAW_STATE_DIR` surcharge le répertoire d'état.
- `OPENCLAW_CONFIG_PATH` surcharge le chemin du fichier de configuration.

Référence complète des variables d'environnement : [Vars d'environnement](/help/environment).

## Aller plus loin

<Columns>
  <Card title="Assistant d'Onboarding (détails)" href="/start/wizard">
    Référence complète de l'assistant CLI et options avancées.
  </Card>
  <Card title="Onboarding app macOS" href="/start/onboarding">
    Flux de premier lancement pour l'app macOS.
  </Card>
</Columns>

## Ce que vous aurez

- Une Gateway en cours d'exécution
- Auth configurée
- Accès UI de Contrôle ou un canal connecté

## Prochaines étapes

- Sécurité DM et approbations : [Appairage](/channels/pairing)
- Connecter plus de canaux : [Canaux](/channels)
- Flux de travail avancés et depuis la source : [Setup](/start/setup)
