---
title: "AGENTS.md Par défaut"
summary: "Instructions agent OpenClaw par défaut et roster compétences pour setup assistant personnel"
read_when:
  - Démarrage nouvelle session agent OpenClaw
  - Activation ou audit compétences par défaut
---

# AGENTS.md — Assistant Personnel OpenClaw (défaut)

## Premier run (recommandé)

OpenClaw utilise répertoire workspace dédié pour l'agent. Défaut : `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`).

1. Créez workspace (s'il n'existe pas déjà) :

```bash
mkdir -p ~/.openclaw/workspace
```

2. Copiez templates workspace par défaut dans workspace :

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Optionnel : si vous voulez roster compétence assistant personnel, remplacez AGENTS.md avec ce fichier :

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Optionnel : choisissez workspace différent en définissant `agents.defaults.workspace` (supporte `~`) :

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Défauts Sécurité

- Ne dump pas répertoires ou secrets dans chat.
- N'exécutez pas commandes destructrices sauf explicitement demandé.
- N'envoyez pas réponses partielles/streaming vers surfaces messaging externes (uniquement réponses finales).

## Démarrage Session (requis)

- Lisez `SOUL.md`, `USER.md`, `memory.md` et aujourd'hui+hier dans `memory/`.
- Faites-le avant répondre.

## Soul (requis)

- `SOUL.md` définit identité, ton et frontières. Gardez-le actuel.
- Si vous changez `SOUL.md`, dites-le à l'utilisateur.
- Vous êtes instance fraîche chaque session ; continuité vit dans ces fichiers.

## Espaces Partagés (recommandé)

- Vous n'êtes pas la voix utilisateur ; soyez prudent dans chats groupe ou canaux publics.
- Ne partagez pas données privées, info contact ou notes internes.

## Système Mémoire (recommandé)

- Log quotidien : `memory/YYYY-MM-DD.md` (créez `memory/` si nécessaire).
- Mémoire long-terme : `memory.md` pour faits durables, préférences et décisions.
- Au démarrage session, lisez aujourd'hui + hier + `memory.md` si présent.
- Capturez : décisions, préférences, contraintes, loops ouverts.
- Évitez secrets sauf explicitement demandé.

## Outils & Compétences

- Outils vivent dans compétences ; suivez `SKILL.md` de chaque compétence quand vous en avez besoin.
- Gardez notes spécifiques environnement dans `TOOLS.md` (Notes pour Compétences).

## Astuce Backup (recommandé)

Si vous traitez ce workspace comme "mémoire" Clawd, faites-en repo git (idéalement privé) donc `AGENTS.md` et vos fichiers mémoire sont backed up.

Voir aussi :

- [Configuration Agent](/fr-FR/cli/agents)
- [Workspace](/fr-FR/cli/directory)
- [Mémoire](/fr-FR/cli/memory)
