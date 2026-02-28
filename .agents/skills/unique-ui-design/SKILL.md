---
name: unique-ui-design
description: Architect and implement high-fidelity, non-generic UI systems. Focuses on "The 5-Layer Authenticity Stack" to ensure every dashboard and landing page feels custom-built, human-centered, and premium.
capabilities: [custom-theming, advanced-layouts, micro-interactions, emotional-ux]
version: 1.0.0
---

# Unique UI Design Skill

## 1. The 5-Layer Authenticity Stack
Rykiri must execute these layers in sequence to ensure the output is cohesive:

**Layer 1: Visual Identity (Beyond Templates)**
Define a unique color psychology (e.g., Deep Obsidian with Electric Violet accents) and use variable typography (weights like 550/650) to break the "standard" feel.

**Layer 2: Purpose-Driven Micro-Interactions**
Every click needs a reaction. Use Framer Motion for spring-based physics. Avoid linear "robotic" transitions.

**Layer 3: Contextual Layout Intelligence**
Move away from standard grids. Use Bento Grids for dashboards and Asymmetric Overlaps for landing pages to create depth.

**Layer 4: Humanized Copy**
Replace "Error: Transaction Failed" with "Something went sideways with the RPC—let's try that again."

**Layer 5: Emotional Architecture**
Design for the user's state (e.g., A "Gas Rescue" tool should feel calm and urgent; a "DeFi Dashboard" should feel powerful and transparent).

## 2. Anti-Generic Guardrails (Hard No's)
Rykiri is strictly prohibited from using:
- Standard Tailwind `gray-500` for text (Use tinted neutrals like `slate-400` or `zinc-400`).
- Perfectly circular buttons with no depth (Use subtle 1px inner borders for a "pressed" look).
- Generic Lucide/Feather icons without styling (Always apply custom stroke widths or duotone coloring).
- Mathematically centered text that looks "off" (Always apply optical balancing).

## 3. Technical Implementation Standards

### Design Token System
Rykiri must implement a semantic token system rather than hardcoding values:

| Token Name | Purpose | Example |
| :--- | :--- | :--- |
| `surface-primary` | Main background | `#09090b` |
| `surface-glass` | Frosted overlays | `rgba(255, 255, 255, 0.03)` |
| `accent-primary` | Key interactions | Neon Cyan / Electric Purple |
| `text-muted` | Low-priority info | Opacity 0.6 + Slight Hue Tilt |

### The "Polish" Checklist
- **Glassmorphism**: Use `backdrop-blur-md` combined with a 1px border at 20% opacity to simulate real glass.
- **Noise Textures**: Apply a subtle grain overlay (0.02 opacity) to backgrounds to eliminate the "flat" digital look.
- **Spring Physics**: Use `stiffness: 300`, `damping: 30` for all hover states to make the UI feel "organic."

## 4. Workflow Instructions
1. **Reference Extraction**: Before coding, identify the "Vibe" (e.g., "Dark, premium, data-heavy, minimalist").
2. **Scaffolding**: Build the `layout.tsx` using an 8px soft grid.
3. **Theming**: Inject the Semantic Tokens into the `tailwind.config.js`.
4. **Interaction Layer**: Wrap key components in `<motion.div>` with custom easing.
5. **Personality Pass**: Rewrite all system labels, tooltips, and empty states to match the brand voice.

## 5. Key Principles for Rykiri
- **Details Compound**: A 1px border and a 20ms delay on a hover effect are the difference between "amateur" and "pro."
- **Accessibility is Foundation**: A beautiful UI that isn't accessible is a failed design. Contrast ratios must always hit WCAG AA.
- **AI as the Builder, Not the Architect**: Rykiri must propose three distinct layout "directions" before committing to the final code.
