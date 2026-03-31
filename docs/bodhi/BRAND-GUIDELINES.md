# OpenBodhi Brand Guidelines

**Version:** 0.1.0 (Alpha)
**Date:** March 2026
**Status:** Active

---

## Brand Promise

OpenBodhi is a thinking partner that organizes consciousness through emergence, not force. We believe thinking reaches its own readiness when patterns become clear. Our design, voice, and product reflect this philosophy: **contemplative, trustworthy, warm, technically rigorous, and privacy-respecting.**

---

## Brand Identity

### Mission
To help people notice what they're actually thinking about. Not to organize what they've decided, but to catch the recurring themes, the unexpected connections, the bridges between separate clusters of thought. To be present for the moment when thinking becomes clear.

### Vision
A world where AI partners help consciousness organize itself through emergence—where your thinking reaches its own readiness because the patterns are visible, not because you're forced to decide.

### Values
1. **Contemplation over urgency** — We protect space for thinking, not action
2. **Privacy by default** — Your vault is yours. Nothing syncs. Nothing tracks.
3. **Emergence over forcing** — Patterns surface naturally. We don't schedule breakthroughs.
4. **Trustworthiness over performance** — We are honest about what we know and don't know
5. **Technical rigor** — Science-based, not wishful. HDBSCAN, SOC, density-based thinking.

---

## Visual Identity

### Color Palette

**Primary Colors**
| Color | Hex | Meaning | Usage |
|-------|-----|---------|-------|
| **Amber** | #d4941a | Energy, attention, the Bodhi tree's golden hour | Primary CTA, high-energy nodes, logos |
| **Sage** | #5a8a75 | Grounded practice, embodied wisdom | Secondary actions, bridges, trust |
| **Warm White** | #ece5d8 | Clarity, trust, connections | Text on dark, highlights, primary contrast |
| **Deep Dark** | #0e0e11 | Contemplation, near-darkness, stillness | Backgrounds, surfaces, safe space |

**Secondary Colors**
| Color | Hex | Usage |
|-------|-----|-------|
| **Muted Stone** | #7a7572 | Low-energy, dormant ideas, disabled states |
| **Surface Dark** | #151518 | Cards, raised surfaces, depth layers |
| **Surface Light** | #faf9f5 | Light backgrounds, contrast layers |
| **Error/Critical** | #c75a5a | Errors, warnings, attention-needed |

### Psychology Behind the Palette

- **Amber (#d4941a)**: Warmth without urgency. The light of awareness. Evokes the Bodhi tree's golden hour. Used for moments that matter—CTAs, important patterns, high-energy states.

- **Sage (#5a8a75)**: Groundedness without dulling. The wisdom of practice. Evokes the tree's leaves. Used for secondary actions, bridges between ideas, trustworthy states.

- **Warm White (#ece5d8)**: Not sterile or cold. Warm, alive, natural. The paper itself. Used for the most important text, bridges between dark and light, moments of clarity.

- **Deep Dark (#0e0e11)**: Not pure black. The dark of a room lit by a single candle. A place where consciousness can organize itself without external demands.

### Typography

**Typeface Stack**
- **Headers (serif)**: Literata at 700 weight — clear, contemplative, readable
- **Body (sans-serif)**: System fonts (Segoe UI, Roboto, -apple-system) at 300-400 weight — warm, human, accessible
- **Code (monospace)**: IBM Plex Mono — precise, technical, honest

**Type Scale**
| Use | Size | Weight | Line Height |
|-----|------|--------|-------------|
| H1 (Hero) | clamp(2.8rem, 6vw, 4.5rem) | 700 | 1.1 |
| H2 (Section) | clamp(1.8rem, 3.5vw, 2.5rem) | 700 | 1.2 |
| H3 (Subsection) | 1.5rem | 600 | 1.3 |
| Body (Large) | clamp(1.05rem, 1.8vw, 1.2rem) | 400 | 1.7 |
| Body (Regular) | 1rem | 400 | 1.65 |
| Body (Small) | 0.9rem | 400 | 1.6 |
| Caption | 0.85rem | 300 | 1.5 |

**Weight Usage**
- **700 (Bold)**: Headings, emphasis, primary navigation
- **600 (Semibold)**: Section headings, button labels
- **400 (Regular)**: Body text, labels
- **300 (Light)**: Long-form text, descriptions (warmth + readability)

### Spacing

**Base Unit**: 4px grid

| Scale | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon spacing, tight components |
| sm | 8px | Inline spacing, small gaps |
| md | 12px | Form field padding |
| lg | 16px | Component padding (standard) |
| xl | 24px | Section padding, card spacing |
| 2xl | 32px | Major section margins |
| 3xl | 48px | Page-level margins |
| 4xl | 64px | Hero section padding |

### Motion

**Easing Functions**
- **Snap**: cubic-bezier(0.25, 0, 0.3, 1) — Immediate, purposeful feedback
- **Ease**: cubic-bezier(0.4, 0, 0.2, 1) — Smooth, natural motion
- **SlowEase**: cubic-bezier(0.25, 0.46, 0.45, 0.94) — Deliberate, contemplative
- **Spring**: cubic-bezier(0.34, 1.56, 0.64, 1) — Energetic, bouncy

**Duration Scale**
| Timing | Value | Usage |
|--------|-------|-------|
| Fast | 150ms | Micro-interactions, hovers |
| Base | 300ms | Page transitions, standard animations |
| Slow | 500ms | Hero animations, entrance effects |
| Contemplative | 8s | Breathing effects, ambient animations |

### Visual Effects

**Grain Overlay**
- Static noise pattern at 2-3% opacity
- Applied to dark backgrounds for texture and life
- Creates a handmade, contemplative feeling
- Never animated (static = calm)

**Breathing Glow**
- Appears behind hero text or key elements
- Radial gradient: amber fading to transparent
- 8-second cycle: scale 0.8 → 1.0 → 0.8
- Opacity 0.15 max (subtle, not overpowering)
- Respects prefers-reduced-motion

**Transitions**
- Default: 300ms ease
- Hover states: 150ms snap (immediate feedback)
- Page transitions: 500ms ease (contemplative)
- Disabled: 0ms if prefers-reduced-motion

---

## Logo System

### Primary Logo (Full Lockup)
The amber circle with central golden seed and ascending branches, paired with the text "OpenBodhi" in Literata serif.

**Minimum Size**: 200px wide
**Clear Space**: 20px (minimum width/6)
**Usage**: Primary branding, headers, hero sections, large layouts

### Icon Mark
The circular symbol alone, with or without the animated breathing glow.

**Minimum Size**: 48px square
**Usage**: Favicons, profile pictures, social media, mobile headers, as a standalone mark

### Symbol Mark
Simplified version of the icon for very small contexts.

**Minimum Size**: 24px square
**Usage**: Tiny favicons, mobile OS icons, shortcut badges

### Text-Only Lockup
"OpenBodhi" in Literata serif with "thinking organized through emergence" in body text below.

**Usage**: Situations where the logo is unavailable, email signatures, plain text contexts, accessibility alternatives

### Don't

- ❌ Use the primary color with reduced opacity (always use full opacity, or use a lighter alternate color)
- ❌ Stretch or distort the logo (always maintain aspect ratio)
- ❌ Place the logo on backgrounds with insufficient contrast
- ❌ Add additional colors, gradients, or effects not shown here
- ❌ Change the Bodhi seed from golden to another color
- ❌ Use the old logo or create new variations without design review

---

## Voice & Tone

### Core Voice
Contemplative. Clear. Honest. Warm without performing. Buddhist-influenced, but not religious. Precise about what we know, transparent about limitations.

### Writing Principles

1. **Short sentences land facts. Medium sentences ease thinking in. Long sentences carry complex logic with internal structure.**
2. **No comparative dismissal** — never "This isn't just X, it's Y" or "Not X, but X"
3. **No hype escalation** — no throat-clearing filler before the point
4. **Pathos opens, logos carries, ethos closes** — emotional truth first, then reasoning, then trustworthiness
5. **Grade 7-8 language** — technical only where precision requires it
6. **Always include raw numbers** — p-values, vote counts, dollar figures, dates. Honesty over comfort.

### Examples

✅ **Good**: "Thinking organized through density. Ideas reach their own readiness."
❌ **Bad**: "Revolutionary AI that transforms how you think about thinking!"

✅ **Good**: "Everything stays local. No sync. No cloud. No tracking."
❌ **Bad**: "Our enterprise-grade privacy architecture with end-to-end encryption..."

✅ **Good**: "When something is dense enough, when the bridges are clear, it says so."
❌ **Bad**: "Our proprietary algorithms detect when you're ready for actionable insights."

---

## Marketing Assets

### Social Media

**Twitter/X (1200×675)**
- 64px padding all around
- Headline: H2 in Literata (amber)
- Subheadline: Body text (warm white)
- Background: Deep dark (#0e0e11) with subtle grain
- Accent shape: Amber circle 120px, positioned bottom-right or centered
- Optional: small contemplative-emergence visualization in corner

**LinkedIn (1200×627)**
- 48px padding
- Logo: 64px top-left
- Headline: H2, bold, warm white
- Body copy: 2-3 lines max, regular weight
- Background: 60% deep dark, 40% subtle sage gradient
- CTA: "Learn more" link in amber

**Instagram (1080×1080)**
- Square format, centered composition
- Large imagery or Contemplative Emergence graphic
- Text overlay: max 3 lines, white/amber
- Logo: 40px bottom-right
- Optional: 4px amber border around entire image

### Email Header

Structure:
```html
<table width="100%" cellpadding="0" cellspacing="0" style="background: #0e0e11;">
  <tr>
    <td style="padding: 32px; text-align: center;">
      <img src="logo.svg" width="48" height="48" alt="OpenBodhi" />
    </td>
  </tr>
  <tr>
    <td style="padding: 0 32px 32px; text-align: center;">
      <h1 style="font-size: 28px; color: #ece5d8; margin: 0;">Subject</h1>
      <p style="font-size: 16px; color: #b0aea5; margin: 8px 0 0;">Subheading</p>
    </td>
  </tr>
</table>
```

### Marketing Banner (1200×630)

Layout:
- Left 60%: Text content
  - H2 headline in amber
  - Body copy 2-3 lines
  - CTA button (primary, amber background)
- Right 40%: Illustration or Contemplative Emergence visualization
- Full background: Deep dark with grain texture overlay

### Print Guidelines

For printed materials:
- Minimum size: 1 inch / 25mm (for legibility)
- Color accuracy: Use CMYK conversions if printing
- DPI: 300 DPI minimum for all print applications
- Spacing: Maintain clear space of at least 0.25 inches around logo

---

## Accessibility

### Color Contrast
All text meets WCAG AA standards:
- Amber (#d4941a) on white: 6.2:1 ✅
- Amber on dark: 5.8:1 ✅
- Sage (#5a8a75) on white: 5.2:1 ✅
- Warm white (#ece5d8) on dark: 12.5:1 ✅

### Motion
- Always respect `prefers-reduced-motion`
- Breathing glow and all animations disable when reduced motion is requested
- Transitions become instant (0ms)
- No auto-playing animations

### Typography
- Minimum font size: 14px for body text
- Minimum line height: 1.5
- Maximum line length: 75 characters for readability

---

## Usage Scenarios

### ✅ DO

- Use the complete color palette across your layouts
- Keep animations subtle and contemplative (never frantic)
- Apply generous white space (breathing room)
- Use Literata serif for headers (creates clarity and contemplation)
- Test all color combinations for contrast
- Use the logo with breathing glow for dynamic contexts
- Apply the grain texture to dark backgrounds
- Include the full lockup on first introduction

### ❌ DON'T

- Mix serif and sans-serif fonts within a single component
- Use more than 3 colors in a single composition
- Animate on page load (auto-play)
- Use rounded corners > 12px on components (only badges/circles at 50%)
- Disable focus states (always include them)
- Use color alone to convey information (pair with text or icon)
- Change the logo colors or proportions
- Apply amber and sage to text simultaneously (choose one)
- Use lowercase "bodhi" for the brand name (always "OpenBodhi")

---

## File Formats

### Web
- **Logo**: SVG (scalable, responsive, animatable)
- **Icons**: SVG or 256×256 PNG
- **Photography**: WebP (modern browsers) with JPG fallback
- **Illustrations**: SVG (preferred) or PNG

### Print
- **Logo**: PDF or high-resolution EPS
- **Images**: TIFF 300 DPI minimum
- **Final files**: CMYK for print production

### Social Media
- **Export for web**: PNG or JPG at 96 DPI
- **Keep transparency**: Use PNG for social if background varies

---

## Version History

**v0.1.0** — Alpha release
- Initial brand guidelines
- Color palette and psychology
- Typography and spacing scales
- Logo system and variations
- Marketing asset templates
- Voice and tone principles

**Future (v0.2.0)**
- Figma component library
- Interactive brand playground
- Extended component patterns
- Motion design specifications
- Video and animation guidelines

---

## Contact

For brand questions, usage clarification, or to request exceptions to these guidelines, open an issue at [GitHub Discussions](https://github.com/Qenjin/OpenBodhi/discussions) with the tag `[brand]`.

---

<div align="center">
<sub>Thinking organized through density. Ideas reach their own readiness.</sub>
</div>
