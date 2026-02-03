# Color Systems

Complete guide to color theory, palettes, contrast, and modern color systems.

## Modern Color Spaces

### oklch() - Recommended
**Advantages:**
- Perceptually uniform (consistent brightness)
- Predictable lightness adjustments
- Better for color manipulation
- Future-proof

**Syntax:** `oklch(L C H / A)`
- L (Lightness): 0-1 (0% black, 100% white)
- C (Chroma): 0-0.4 (saturation, 0 = gray)
- H (Hue): 0-360 (degrees on color wheel)
- A (Alpha): 0-1 (optional)

**Examples:**
```css
--primary: oklch(0.65 0.24 267);     /* Blue */
--primary-hover: oklch(0.75 0.24 267); /* Lighter */
--primary-muted: oklch(0.65 0.12 267); /* Less saturated */
```

### HSL
**Good for:** Quick adjustments, legacy support

```css
--primary: hsl(267, 70%, 60%);
--primary-light: hsl(267, 70%, 80%); /* Lighter */
```

### RGB/Hex
**Good for:** Designer handoff, legacy browsers

```css
--primary: #667eea;
--primary-rgb: rgb(102, 126, 234);
```

---

## Semantic Color System

### Light Mode Base
```css
:root {
  /* Background layers */
  --bg-base: oklch(1 0 0);           /* Pure white */
  --bg-surface: oklch(0.98 0 0);     /* Subtle gray */
  --bg-elevated: oklch(1 0 0);       /* White (cards) */
  
  /* Text */
  --text-primary: oklch(0.15 0 0);   /* Near black */
  --text-secondary: oklch(0.45 0 0); /* Medium gray */
  --text-tertiary: oklch(0.65 0 0);  /* Light gray */
  
  /* UI */
  --border: oklch(0.85 0 0);         /* Light border */
  --divider: oklch(0.90 0 0);        /* Subtle divider */
  
  /* Interactive */
  --primary: oklch(0.65 0.24 267);   /* Brand blue */
  --primary-hover: oklch(0.70 0.24 267);
  --primary-active: oklch(0.60 0.24 267);
  
  /* Semantic */
  --success: oklch(0.70 0.15 160);   /* Green */
  --warning: oklch(0.75 0.15 85);    /* Yellow */
  --error: oklch(0.65 0.20 25);      /* Red */
  --info: oklch(0.70 0.15 250);      /* Blue */
}
```

### Dark Mode
```css
@media (prefers-color-scheme: dark) {
  :root {
    /* Backgrounds */
    --bg-base: oklch(0.145 0 0);       /* Very dark */
    --bg-surface: oklch(0.185 0 0);    /* Slightly lighter */
    --bg-elevated: oklch(0.225 0 0);   /* Cards */
    
    /* Text (inverted) */
    --text-primary: oklch(0.95 0 0);   /* Near white */
    --text-secondary: oklch(0.65 0 0); /* Medium gray */
    --text-tertiary: oklch(0.45 0 0);  /* Darker gray */
    
    /* UI */
    --border: oklch(0.30 0 0);
    --divider: oklch(0.25 0 0);
    
    /* Interactive (slightly adjusted for dark) */
    --primary: oklch(0.70 0.22 267);
    --primary-hover: oklch(0.75 0.22 267);
    --primary-active: oklch(0.65 0.22 267);
  }
}
```

---

## Color Contrast (WCAG)

### Minimum Requirements

**Level AA (Standard):**
- Normal text (<18pt): 4.5:1 contrast
- Large text (≥18pt or 14pt bold): 3:1 contrast
- UI components: 3:1 contrast

**Level AAA (Enhanced):**
- Normal text: 7:1 contrast
- Large text: 4.5:1 contrast

### Testing Tools
- **contrast-ratio.com** - Quick check
- **WebAIM Contrast Checker**
- **Figma/Sketch plugins**
- **Chrome DevTools** (built-in)

### Common Mistakes
```css
/* ❌ BAD: Insufficient contrast (2.5:1) */
color: #999;
background: #fff;

/* ✅ GOOD: Sufficient contrast (4.6:1) */
color: #666;
background: #fff;
```

---

## Color Palettes

### Building a Palette

**Start with Primary:**
```css
--primary-50:  oklch(0.95 0.05 267);
--primary-100: oklch(0.90 0.10 267);
--primary-200: oklch(0.85 0.15 267);
--primary-300: oklch(0.75 0.18 267);
--primary-400: oklch(0.70 0.21 267);
--primary-500: oklch(0.65 0.24 267); /* Base */
--primary-600: oklch(0.60 0.24 267);
--primary-700: oklch(0.50 0.22 267);
--primary-800: oklch(0.40 0.20 267);
--primary-900: oklch(0.30 0.18 267);
```

### Color Harmonies

**Analogous (Adjacent):**
- Blue: 240°
- Blue-Purple: 260°
- Purple: 280°

**Complementary (Opposite):**
- Blue: 240°
- Orange: 30° (240° + 150°)

**Triadic (120° apart):**
- Blue: 240°
- Red: 0°
- Yellow: 120°

---

## Color Psychology

### Meanings by Color

**Blue (240-270°):**
- Trust, stability, professionalism
- Tech companies, finance, healthcare
- Calming, reliable

**Green (120-160°):**
- Growth, health, nature
- Environmental, finance, wellness
- Positive, fresh

**Red (0-30°):**
- Energy, urgency, passion
- Food, entertainment, alerts
- Attention-grabbing, bold

**Yellow (60-100°):**
- Optimism, warmth, caution
- Energy, warnings, highlights
- Bright, cheerful

**Purple (270-300°):**
- Luxury, creativity, wisdom
- Beauty, premium products
- Sophisticated, mysterious

**Orange (30-60°):**
- Friendliness, enthusiasm, confidence
- Retail, food, calls-to-action
- Energetic, approachable

---

## Gradients

### Linear Gradients
```css
/* Simple two-color */
background: linear-gradient(135deg, 
  oklch(0.65 0.24 267), 
  oklch(0.60 0.22 290)
);

/* Multi-stop */
background: linear-gradient(to bottom,
  oklch(0.70 0.24 267) 0%,
  oklch(0.65 0.22 280) 50%,
  oklch(0.60 0.20 290) 100%
);
```

### Radial Gradients
```css
background: radial-gradient(circle at center,
  oklch(0.70 0.24 267),
  oklch(0.50 0.22 280)
);
```

### Mesh Gradients (Modern)
```css
background: 
  radial-gradient(at 20% 30%, oklch(0.65 0.24 267) 0px, transparent 50%),
  radial-gradient(at 80% 70%, oklch(0.70 0.20 290) 0px, transparent 50%),
  oklch(0.145 0 0);
```

---

## Accessibility Considerations

### Color Blindness
**Types:**
- **Deuteranopia** (red-green, most common)
- **Protanopia** (red-green)
- **Tritanopia** (blue-yellow, rare)

**Solutions:**
- Never rely on color alone (use icons, labels)
- Test with simulators (Figma, Chrome DevTools)
- High contrast alternatives
- Patterns/textures in addition to color

### Reduced Contrast Mode
```css
@media (prefers-contrast: more) {
  :root {
    --text-primary: oklch(0 0 0); /* Pure black */
    --bg-base: oklch(1 0 0);      /* Pure white */
  }
}
```

### Dark Mode Preferences
```css
@media (prefers-color-scheme: dark) {
  /* Automatic dark mode */
}

@media (prefers-color-scheme: light) {
  /* Automatic light mode */
}
```

---

## Tools & Resources

**Color Pickers:**
- oklch.com - Modern color picker
- coolors.co - Palette generator
- color.adobe.com - Adobe Color
- paletton.com - Color schemes

**Contrast Checkers:**
- contrast-ratio.com
- webaim.org/resources/contrastchecker
- whocanuse.com (detailed breakdown)

**Accessibility:**
- Stark (Figma/Sketch plugin)
- Color Oracle (color blindness simulator)
- Chrome DevTools (built-in)

---

## Quick Reference

### Safe Color Choices

**Neutral Grays:**
```css
--gray-50:  oklch(0.98 0 0);
--gray-100: oklch(0.95 0 0);
--gray-200: oklch(0.90 0 0);
--gray-300: oklch(0.83 0 0);
--gray-400: oklch(0.70 0 0);
--gray-500: oklch(0.56 0 0);
--gray-600: oklch(0.45 0 0);
--gray-700: oklch(0.35 0 0);
--gray-800: oklch(0.25 0 0);
--gray-900: oklch(0.15 0 0);
```

**Status Colors:**
```css
--success: oklch(0.70 0.15 160); /* Green */
--warning: oklch(0.75 0.15 85);  /* Yellow */
--error: oklch(0.65 0.20 25);    /* Red */
--info: oklch(0.70 0.15 250);    /* Blue */
```

---

*For dark mode implementation, see dark-mode.md. For complete design systems, see SKILL.md.*
