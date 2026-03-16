---
summary: "Intégration scriptée et configuration d'agent pour la CLI OpenClaw"
read_when:
  - Vous automatisez l'intégration dans des scripts ou CI
  - Vous avez besoin d'exemples non interactifs pour des fournisseurs spécifiques
title: "Automatisation CLI"
sidebarTitle: "Automatisation CLI"
---

# Automatisation CLI

Utilisez `--non-interactive` pour automatiser `openclaw onboard`.

<Note>
`--json` n'implique pas le mode non interactif. Utilisez `--non-interactive` (et `--workspace`) pour les scripts.
</Note>

## Exemple de base non interactif

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Ajoutez `--json` pour un résumé lisible par machine.

## Exemples spécifiques aux fournisseurs

<AccordionGroup>
  <Accordion title="Exemple Gemini">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Exemple Z.AI">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Exemple Vercel AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Exemple Cloudflare AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "votre-id-compte" \
      --cloudflare-ai-gateway-gateway-id "votre-id-passerelle" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Exemple Moonshot">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Exemple Synthetic">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Exemple OpenCode Zen">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Exemple de fournisseur personnalisé">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice custom-api-key \
      --custom-base-url "https://llm.example.com/v1" \
      --custom-model-id "foo-large" \
      --custom-api-key "$CUSTOM_API_KEY" \
      --custom-provider-id "mon-personnalisé" \
      --custom-compatibility anthropic \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```

    `--custom-api-key` est optionnel. Si omis, l'intégration vérifie `CUSTOM_API_KEY`.

  </Accordion>
</AccordionGroup>

## Ajouter un autre agent

Utilisez `openclaw agents add <nom>` pour créer un agent séparé avec son propre espace de travail, ses sessions et ses profils d'authentification. L'exécuter sans `--workspace` lance l'assistant.

```bash
openclaw agents add travail \
  --workspace ~/.openclaw/workspace-travail \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Ce qu'il définit :

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notes :

- Les espaces de travail par défaut suivent `~/.openclaw/workspace-<agentId>`.
- Ajoutez des `bindings` pour acheminer les messages entrants (l'assistant peut le faire).
- Indicateurs non interactifs : `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Documentation connexe

- Centre d'intégration : [Assistant d'intégration (CLI)](/fr-FR/start/wizard)
- Référence complète : [Référence d'intégration CLI](/fr-FR/start/wizard-cli-reference)
- Référence de commande : [`openclaw onboard`](/fr-FR/cli/onboard)
