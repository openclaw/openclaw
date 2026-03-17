---
title: Hub
summary: "Browse and activate from the 147+ Persona Registry — specialized workers for any task."
---

# Hub

The **Hub** is your gateway to the **Persona Registry**. While Operator1 ships with 4 core agents, the Hub allows you to discover and spawn from a library of over 147 specialized personas.

## Persona Discover

Browse personas organized by department:

- **Engineering**: Backend architects, SREs, Security researchers.
- **Marketing**: SEO experts, Content strategists, Graphic designers.
- **Finance**: Audit specialists, Compliance officers.

Each persona card in the Hub shows:

- **Role & Expertise**: What this agent is uniquely qualified for.
- **Identity Path**: Link to the master `.md` definition file in `agents/personas/`.
- **Default Model**: The recommended LLM for this specific persona.

## Activating a Persona

Personas are **dynamically spawned** workers (Tier 3). To use a persona:

1. Browse the Hub to find the right role.
2. Operator1 or a Tier 2 Manager (Neo, Morpheus, Trinity) will automatically reference the persona slug when a task requires it.
3. The gateway injects the persona's `SOUL.md` and `AGENTS.md` into the dynamic session.

## Customization

You can extend the Hub by adding your own personas to `~/.openclaw/agents/personas/`. The registry auto-indexes any new `.md` files found in this directory.
