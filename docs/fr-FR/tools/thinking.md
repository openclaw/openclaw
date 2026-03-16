---
summary: "Syntaxe directive pour /think + /verbose et comment ils affectent reasoning modèle"
read_when:
  - Ajustement parsing directive thinking ou verbose ou défauts
title: "Niveaux Thinking"
---

# Niveaux Thinking (directives /think)

## Ce que ça fait

- Directive inline dans n'importe quel body inbound : `/t <level>`, `/think:<level>` ou `/thinking <level>`.
- Niveaux (alias) : `off | minimal | low | medium | high | xhigh` (modèles GPT-5.2 + Codex seulement)
  - minimal → "think"
  - low → "think hard"
  - medium → "think harder"
  - high → "ultrathink" (budget max)
  - xhigh → "ultrathink+" (modèles GPT-5.2 + Codex seulement)
  - `x-high`, `x_high`, `extra-high`, `extra high` et `extra_high` mappent vers `xhigh`.
  - `highest`, `max` mappent vers `high`.
- Notes provider :
  - Z.AI (`zai/*`) supporte seulement thinking binaire (`on`/`off`). N'importe quel niveau non-`off` traité comme `on` (mappé vers `low`).

## Ordre résolution

1. Directive inline sur message (s'applique seulement à ce message).
2. Override session (défini en envoyant message directive-only).
3. Défaut global (`agents.defaults.thinkingDefault` dans config).
4. Fallback : low pour modèles capable reasoning ; off sinon.

## Définir défaut session

- Envoyez message qui est **seulement** directive (whitespace autorisé), ex : `/think:medium` ou `/t high`.
- Cela stick pour session actuelle (per-sender par défaut) ; cleared par `/think:off` ou reset idle session.
- Réponse confirmation envoyée (`Thinking level set to high.` / `Thinking disabled.`). Si niveau invalide (ex : `/thinking big`), commande rejetée avec hint et état session laissé inchangé.
- Envoyez `/think` (ou `/think:`) sans argument pour voir niveau thinking actuel.

## Application par agent

- **Pi Embarqué** : niveau résolu passé vers runtime agent Pi in-process.

## Directives verbose (/verbose ou /v)

- Niveaux : `on` (minimal) | `full` | `off` (défaut).
- Message directive-only toggle verbose session et répond `Verbose logging enabled.` / `Verbose logging disabled.` ; niveaux invalides retournent hint sans changer état.
- `/verbose off` stocke override session explicite ; clearlez via UI Sessions en choisissant `inherit`.
- Directive inline affecte seulement ce message ; défauts session/globaux s'appliquent sinon.
- Envoyez `/verbose` (ou `/verbose:`) sans argument pour voir niveau verbose actuel.
- Quand verbose on, agents qui émettent résultats tool structurés (Pi, autres agents JSON) envoient chaque appel tool back comme propre message metadata-only, préfixé avec `<emoji> <tool-name>: <arg>` quand disponible (path/commande). Ces résumés tool envoyés dès chaque tool démarre (bulles séparées), pas comme deltas streaming.
- Quand verbose `full`, outputs tool aussi forwardés après complétion (bulle séparée, tronqué vers longueur sûre). Si vous togglez `/verbose on|full|off` pendant run in-flight, bulles tool suivantes honorent nouveau setting.

## Visibilité reasoning (/reasoning)

- Niveaux : `on|off|stream`.
- Message directive-only toggle si blocs thinking affichés dans réponses.
- Quand activé, reasoning envoyé comme **message séparé** préfixé avec `Reasoning:`.
- `stream` (Telegram seulement) : stream reasoning dans bulle draft Telegram pendant génération réponse, puis envoie réponse finale sans reasoning.
- Alias : `/reason`.
- Envoyez `/reasoning` (ou `/reasoning:`) sans argument pour voir niveau reasoning actuel.

## Relaté

- Docs mode elevated vivent dans [Mode Elevated](/fr-FR/tools/elevated).

## Heartbeats

- Body probe heartbeat est prompt heartbeat configuré (défaut : `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Directives inline dans message heartbeat s'appliquent comme d'habitude (mais évitez changer défauts session depuis heartbeats).
- Delivery heartbeat défaut vers payload final seulement. Pour aussi envoyer message séparé `Reasoning:` (quand disponible), définissez `agents.defaults.heartbeat.includeReasoning: true` ou per-agent `agents.list[].heartbeat.includeReasoning: true`.

## UI chat web

- Sélecteur thinking chat web miroir niveau stocké session depuis store session inbound/config quand page charge.
- Choisir autre niveau s'applique seulement au prochain message (`thinkingOnce`) ; après envoi, sélecteur snap back vers niveau session stocké.
- Pour changer défaut session, envoyez directive `/think:<level>` (comme avant) ; sélecteur le reflétera après prochain reload.

## Exemples

**Thinking high pour un message :**

```
/think:high Résous cette équation complexe
```

**Définir thinking medium pour session :**

```
/think:medium
```

**Désactiver thinking :**

```
/think:off
```

**Verbose full pour debugging :**

```
/verbose:full Debug ce problème
```

Voir aussi :

- [Boucle Agent](/fr-FR/concepts/agent-loop)
- [Modèles](/fr-FR/concepts/models)
- [Configuration](/fr-FR/gateway/configuration)
