---
summary: "Modele d'espace de travail pour TOOLS.md"
read_when:
  - Mise en place manuelle d'un espace de travail
x-i18n:
  source_path: reference/templates/TOOLS.md
  source_hash: 3ed08cd537620749
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:39Z
---

# TOOLS.md - Notes locales

Les Skills definissent _comment_ les outils fonctionnent. Ce fichier est pour _vos_ specificites — ce qui est unique a votre configuration.

## Ce qui va ici

Des choses comme :

- Noms et emplacements des cameras
- Hotes SSH et alias
- Voix preferees pour le TTS
- Noms des haut-parleurs/salles
- Surnoms des appareils
- Tout ce qui est specifique a l'environnement

## Exemples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Pourquoi separer ?

Les Skills sont partages. Votre configuration est la votre. Les garder separes signifie que vous pouvez mettre a jour les Skills sans perdre vos notes, et partager des Skills sans divulguer votre infrastructure.

---

Ajoutez tout ce qui vous aide a faire votre travail. Ceci est votre aide-memoire.
