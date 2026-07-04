---
name: web-design-master
description: "Design, redesign, implement, or critique polished websites, dashboards, landing pages, and web applications."
---

# Web Design Master

Create distinctive, production-ready web interfaces. Treat visual quality, usability, implementation quality, accessibility, and responsive behavior as one job.

## Default stance

- For dashboards, admin panels, and internal tools: **daily-use-first / ops-first**. Optimize frequent actions, scanning speed, error prevention, keyboard use, and information density before decoration.
- For landing pages and public websites: **message-first / conversion-first**. Make the value proposition, proof, and primary action obvious.
- For content-heavy experiences: **reading-first**. Prioritize typography, rhythm, navigation, and content structure.
- Preserve the existing framework, design language, and dependencies unless replacement is necessary.

## Workflow

1. **Inspect before designing**
   - Read the existing app structure, routes, components, styles, tokens, and assets.
   - Identify the primary user, top tasks, page purpose, and current failure points.
   - Reuse working patterns; do not rebuild the application for visual novelty.

2. **Define the experience**
   - Write the page goal in one sentence.
   - Identify the primary action, secondary actions, key information, and required states.
   - For operational interfaces, rank actions by frequency and consequence.

3. **Choose a deliberate visual direction**
   - Load `references/visual-directions.md` when selecting a style.
   - Pick one coherent direction. Do not combine unrelated aesthetics.
   - Explain the direction briefly before implementation when the request is open-ended.

4. **Establish the system**
   - Define typography, color roles, spacing, radii, elevation, grid, breakpoints, and motion.
   - Use reusable tokens instead of scattered magic values.
   - Build primitives first: page shell, section, stack, cluster, card, button, field, table, status, dialog, and empty state.

5. **Implement complete states**
   - Cover loading, empty, success, warning, error, disabled, focus, hover, active, and permission-denied states where relevant.
   - Use realistic content and data shapes. Avoid meaningless placeholder copy in the final result.
   - Keep destructive actions visually distinct and require confirmation proportional to risk.

6. **Verify**
   - Load `references/quality-gates.md` and check every applicable gate.
   - Test at 360, 768, 1024, 1440, and 1920 CSS pixels, plus content zoom where possible.
   - Run `python skills/web-design-master/scripts/audit_web.py <path>` for static HTML/CSS work.
   - Fix issues before presenting the result; do not merely list known defects.

## Design requirements

- Clear visual hierarchy with one dominant focal point per view.
- Strong typography and intentional spacing; no arbitrary font-size ladder.
- Sufficient contrast and visible keyboard focus.
- Semantic HTML and accessible names for controls.
- Responsive layouts that reflow, not desktop layouts squeezed onto mobile.
- Tables and dense data remain scannable: sticky context, aligned numbers, explicit units, clear status, and useful filtering.
- Motion communicates state or spatial relationship; it must not delay work.
- Use icons only when their meaning is recognizable or paired with text.
- Prefer progressive disclosure over showing every control at once.

## Avoid generic AI design

Do not default to purple-blue gradients, glass cards, excessive glow, giant rounded rectangles, random floating shapes, or identical card grids. Do not use visual effects without a functional reason. A restrained interface with excellent hierarchy is better than a decorative but generic one.

## Implementation rules

- Prefer CSS variables and existing component primitives.
- Keep components small enough to reason about but do not fragment trivial markup.
- Avoid adding a UI library for one component.
- Avoid fixed heights for content containers unless the interaction requires them.
- Do not hide overflow to mask broken layout.
- Use native controls when they provide better accessibility and behavior.
- Respect `prefers-reduced-motion`, system zoom, text expansion, and touch target sizing.
- Keep performance in scope: optimize images, fonts, and above-the-fold rendering.

## Output contract

When delivering a build or redesign, include:

- the chosen direction and why it fits the product;
- the key user-flow and usability decisions;
- files changed and how to run the result;
- responsive and accessibility checks performed;
- any genuine limitation that remains.

Do not present a visual concept as finished when it has not been implemented or verified.
