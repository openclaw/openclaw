# Clawdbrain Landing Page — Complete Design & Implementation Plan

**Branch:** `landing-page-ux`
**Tech Stack:** Lit Web Components, Tailwind CSS v4, Vite, TypeScript
**Date:** 2026-01-25

---

## Table of Contents

1. [Design Overview](#design-overview)
2. [Color Palette & Design Tokens](#color-palette--design-tokens)
3. [Typography](#typography)
4. [Animation System](#animation-system)
5. [Section 1: Hero](#section-1-hero)
6. [Section 2: Understanding You](#section-2-understanding-you)
7. [Section 3: 24/7 Activity Timeline](#section-3-247-activity-timeline)
8. [Section 4: Control & Guardrails](#section-4-control--guardrails)
9. [Section 5: Features Bento Grid](#section-5-features-bento-grid)
10. [Section 6: Social Proof & CTA](#section-6-social-proof--cta)
11. [Footer](#footer)
12. [Responsive Breakpoints](#responsive-breakpoints)
13. [File Structure](#file-structure)
14. [Implementation Tasks](#implementation-tasks)

---

## Design Overview

### Value Proposition Narrative Flow

| Section | Message | Emotional Goal |
|---------|---------|----------------|
| Hero | "Turn your ideas into reality, automatically" | Aspiration, excitement |
| Understanding | "An AI that truly knows you" | Trust, personalization |
| 24/7 Work | "Works around the clock" | Relief, efficiency |
| Control | "Autonomous, not unsupervised" | Safety, confidence |
| Features | "What Clawdbrain can do" | Capability, comprehension |
| Social Proof | "People are realizing dreams" | Validation, FOMO |
| CTA | "Ready to meet your AI?" | Urgency, action |

### Core Design Principles

1. **Sophisticated but approachable** — Dark mode default with warm accents
2. **Motion with purpose** — Every animation reinforces the "working for you" narrative
3. **Progressive disclosure** — Complexity revealed gradually on scroll
4. **Non-technical first** — Language and visuals accessible to everyone

---

## Color Palette & Design Tokens

### CSS Custom Properties (add to `ui/src/styles/design-system.css`)

```css
/* ============================================
   LANDING PAGE COLOR PALETTE
   ============================================ */

:root {
  /* Primary brand colors */
  --landing-primary: #6366f1;        /* Indigo-500 - main accent */
  --landing-primary-light: #818cf8;  /* Indigo-400 */
  --landing-primary-dark: #4f46e5;   /* Indigo-600 */

  /* Secondary accents */
  --landing-accent-warm: #f59e0b;    /* Amber-500 - for highlights */
  --landing-accent-coral: #fb7185;   /* Rose-400 - for energy */
  --landing-accent-teal: #2dd4bf;    /* Teal-400 - for calm/analytical */
  --landing-accent-lavender: #a78bfa; /* Violet-400 */

  /* Neutral palette */
  --landing-bg-dark: #0a0a0f;        /* Near-black with blue tint */
  --landing-bg-elevated: #12121a;    /* Slightly lighter for cards */
  --landing-bg-surface: #1a1a24;     /* Card backgrounds */
  --landing-border: rgba(255, 255, 255, 0.08);
  --landing-border-hover: rgba(255, 255, 255, 0.15);

  /* Text hierarchy */
  --landing-text-primary: #f8fafc;   /* Slate-50 */
  --landing-text-secondary: #94a3b8; /* Slate-400 */
  --landing-text-muted: #64748b;     /* Slate-500 */

  /* Gradients */
  --landing-gradient-hero: linear-gradient(
    135deg,
    rgba(99, 102, 241, 0.15) 0%,
    rgba(168, 85, 247, 0.08) 50%,
    rgba(45, 212, 191, 0.05) 100%
  );

  --landing-gradient-aurora: radial-gradient(
    ellipse 80% 50% at 50% -20%,
    rgba(99, 102, 241, 0.3) 0%,
    transparent 70%
  );

  --landing-gradient-card: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.05) 0%,
    rgba(255, 255, 255, 0.02) 100%
  );

  /* Shadows */
  --landing-shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.3);
  --landing-shadow-md: 0 4px 20px rgba(0, 0, 0, 0.4);
  --landing-shadow-lg: 0 8px 40px rgba(0, 0, 0, 0.5);
  --landing-shadow-glow: 0 0 40px rgba(99, 102, 241, 0.3);

  /* Glassmorphism */
  --landing-glass-bg: rgba(255, 255, 255, 0.03);
  --landing-glass-border: rgba(255, 255, 255, 0.08);
  --landing-glass-blur: blur(20px);
}

/* Light mode overrides (if needed) */
[data-theme="light"] {
  --landing-bg-dark: #fafafa;
  --landing-bg-elevated: #ffffff;
  --landing-bg-surface: #f8fafc;
  --landing-border: rgba(0, 0, 0, 0.06);
  --landing-border-hover: rgba(0, 0, 0, 0.12);
  --landing-text-primary: #0f172a;
  --landing-text-secondary: #475569;
  --landing-text-muted: #64748b;

  --landing-gradient-aurora: radial-gradient(
    ellipse 80% 50% at 50% -20%,
    rgba(99, 102, 241, 0.1) 0%,
    transparent 70%
  );
}
```

---

## Typography

### Font Stack

```css
/* Add to design-system.css */
:root {
  --landing-font-display: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --landing-font-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --landing-font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}

/* Typography scale */
.landing-h1 {
  font-family: var(--landing-font-display);
  font-size: clamp(2.5rem, 6vw, 4.5rem);
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--landing-text-primary);
}

.landing-h2 {
  font-family: var(--landing-font-display);
  font-size: clamp(1.875rem, 4vw, 3rem);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--landing-text-primary);
}

.landing-h3 {
  font-family: var(--landing-font-display);
  font-size: clamp(1.25rem, 2vw, 1.5rem);
  font-weight: 600;
  line-height: 1.3;
  color: var(--landing-text-primary);
}

.landing-body {
  font-family: var(--landing-font-body);
  font-size: 1.125rem;
  line-height: 1.7;
  color: var(--landing-text-secondary);
}

.landing-body-sm {
  font-family: var(--landing-font-body);
  font-size: 0.875rem;
  line-height: 1.6;
  color: var(--landing-text-muted);
}

.landing-label {
  font-family: var(--landing-font-body);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--landing-text-muted);
}
```

---

## Animation System

### Core Animation Keyframes

```css
/* Add to ui/src/styles/landing-animations.css */

/* ============================================
   ENTRANCE ANIMATIONS
   ============================================ */

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(30px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes fadeInDown {
  from {
    opacity: 0;
    transform: translateY(-20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes slideInLeft {
  from {
    opacity: 0;
    transform: translateX(-40px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes slideInRight {
  from {
    opacity: 0;
    transform: translateX(40px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes scaleIn {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes blurIn {
  from {
    opacity: 0;
    filter: blur(10px);
  }
  to {
    opacity: 1;
    filter: blur(0);
  }
}

/* ============================================
   CONTINUOUS ANIMATIONS
   ============================================ */

@keyframes float {
  0%, 100% {
    transform: translateY(0) rotate(var(--float-rotate, 0deg));
  }
  50% {
    transform: translateY(-15px) rotate(var(--float-rotate, 0deg));
  }
}

@keyframes floatSlow {
  0%, 100% {
    transform: translate(0, 0);
  }
  25% {
    transform: translate(5px, -10px);
  }
  50% {
    transform: translate(0, -15px);
  }
  75% {
    transform: translate(-5px, -8px);
  }
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

@keyframes pulseGlow {
  0%, 100% {
    box-shadow: 0 0 20px rgba(99, 102, 241, 0.3);
  }
  50% {
    box-shadow: 0 0 40px rgba(99, 102, 241, 0.6);
  }
}

@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

@keyframes drawLine {
  from {
    stroke-dashoffset: 1000;
  }
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes typewriter {
  from {
    width: 0;
  }
  to {
    width: 100%;
  }
}

/* ============================================
   TEXT ROTATION ANIMATION
   ============================================ */

@keyframes textRotateOut {
  0% {
    opacity: 1;
    transform: translateY(0);
    filter: blur(0);
  }
  100% {
    opacity: 0;
    transform: translateY(-100%);
    filter: blur(8px);
  }
}

@keyframes textRotateIn {
  0% {
    opacity: 0;
    transform: translateY(100%);
    filter: blur(8px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
    filter: blur(0);
  }
}

/* ============================================
   SCROLL-TRIGGERED ANIMATIONS
   ============================================ */

.animate-on-scroll {
  opacity: 0;
  transform: translateY(30px);
  transition: opacity 0.6s ease-out, transform 0.6s ease-out;
}

.animate-on-scroll.is-visible {
  opacity: 1;
  transform: translateY(0);
}

/* Stagger delays for children */
.stagger-children > *:nth-child(1) { transition-delay: 0ms; }
.stagger-children > *:nth-child(2) { transition-delay: 100ms; }
.stagger-children > *:nth-child(3) { transition-delay: 200ms; }
.stagger-children > *:nth-child(4) { transition-delay: 300ms; }
.stagger-children > *:nth-child(5) { transition-delay: 400ms; }
.stagger-children > *:nth-child(6) { transition-delay: 500ms; }

/* ============================================
   PARALLAX UTILITIES
   ============================================ */

.parallax-layer {
  will-change: transform;
  transition: transform 0.1s linear;
}

.parallax-slow {
  --parallax-speed: 0.3;
}

.parallax-medium {
  --parallax-speed: 0.5;
}

.parallax-fast {
  --parallax-speed: 0.8;
}
```

### JavaScript Animation Utilities

```typescript
// ui/src/ui/landing/animation-utils.ts

/**
 * Intersection Observer for scroll-triggered animations
 */
export function createScrollObserver(
  options: IntersectionObserverInit = {}
): IntersectionObserver {
  const defaultOptions: IntersectionObserverInit = {
    root: null,
    rootMargin: '0px 0px -10% 0px',
    threshold: 0.1,
    ...options,
  };

  return new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
      }
    });
  }, defaultOptions);
}

/**
 * Parallax scroll effect
 */
export function initParallax(container: HTMLElement): () => void {
  const layers = container.querySelectorAll<HTMLElement>('.parallax-layer');

  function updateParallax() {
    const scrollY = window.scrollY;
    const containerRect = container.getBoundingClientRect();
    const containerTop = containerRect.top + scrollY;
    const relativeScroll = scrollY - containerTop;

    layers.forEach((layer) => {
      const speed = parseFloat(
        getComputedStyle(layer).getPropertyValue('--parallax-speed') || '0.5'
      );
      const yOffset = relativeScroll * speed;
      layer.style.transform = `translateY(${yOffset}px)`;
    });
  }

  window.addEventListener('scroll', updateParallax, { passive: true });
  updateParallax();

  return () => window.removeEventListener('scroll', updateParallax);
}

/**
 * Text rotation animation controller
 */
export class TextRotator {
  private element: HTMLElement;
  private texts: string[];
  private currentIndex = 0;
  private interval: number;
  private timerId?: ReturnType<typeof setInterval>;

  constructor(element: HTMLElement, texts: string[], interval = 3000) {
    this.element = element;
    this.texts = texts;
    this.interval = interval;
  }

  start(): void {
    this.render();
    this.timerId = setInterval(() => this.next(), this.interval);
  }

  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
    }
  }

  private next(): void {
    this.currentIndex = (this.currentIndex + 1) % this.texts.length;
    this.animate();
  }

  private animate(): void {
    this.element.style.animation = 'textRotateOut 0.4s ease-in forwards';

    setTimeout(() => {
      this.render();
      this.element.style.animation = 'textRotateIn 0.4s ease-out forwards';
    }, 400);
  }

  private render(): void {
    this.element.textContent = this.texts[this.currentIndex];
  }
}

/**
 * Smooth scroll to anchor
 */
export function smoothScrollTo(target: string | HTMLElement): void {
  const element = typeof target === 'string'
    ? document.querySelector(target)
    : target;

  if (element) {
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }
}

/**
 * Staggered animation for multiple elements
 */
export function staggerAnimation(
  elements: NodeListOf<Element> | Element[],
  animationClass: string,
  staggerMs = 100
): void {
  Array.from(elements).forEach((el, index) => {
    setTimeout(() => {
      el.classList.add(animationClass);
    }, index * staggerMs);
  });
}
```

---

## Section 1: Hero

### Component Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  [Logo]                                      [Nav] [Get Started]│  ← Sticky header
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│           ┌──────┐                          ┌──────┐           │
│           │Agent │                          │Agent │           │  ← Floating cards
│           │Card 1│                          │Card 2│           │     (parallax)
│           └──────┘                          └──────┘           │
│                                                                 │
│                    Turn your ideas into reality.                │  ← Main headline
│                        [Automatically.]                         │  ← Rotating text
│                                                                 │
│            An AI that works for you — researching,              │  ← Subheadline
│            building, and delivering while you focus             │
│            on what matters most.                                │
│                                                                 │
│              [Get Started]  [See How It Works]                  │  ← CTAs
│                                                                 │
│           ┌──────┐                          ┌──────┐           │
│           │Agent │                          │Agent │           │  ← More floating
│           │Card 3│                          │Card 4│           │     cards
│           └──────┘                          └──────┘           │
│                                                                 │
│                           ∨                                     │  ← Scroll indicator
└─────────────────────────────────────────────────────────────────┘
```

### Lit Component: Hero Section

```typescript
// ui/src/ui/landing/sections/hero-section.ts

import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { TextRotator, initParallax } from '../animation-utils';

interface FloatingCard {
  id: string;
  icon: string;
  label: string;
  status: 'active' | 'complete' | 'pending';
  position: {
    top?: string;
    bottom?: string;
    left?: string;
    right?: string;
  };
  rotation: number;
  parallaxSpeed: number;
}

const FLOATING_CARDS: FloatingCard[] = [
  {
    id: 'research',
    icon: '🔍',
    label: 'Researching...',
    status: 'active',
    position: { top: '15%', left: '8%' },
    rotation: -3,
    parallaxSpeed: 0.3,
  },
  {
    id: 'building',
    icon: '🔨',
    label: 'Building...',
    status: 'active',
    position: { top: '20%', right: '10%' },
    rotation: 4,
    parallaxSpeed: 0.5,
  },
  {
    id: 'learning',
    icon: '🧠',
    label: 'Learning...',
    status: 'active',
    position: { bottom: '25%', left: '12%' },
    rotation: 2,
    parallaxSpeed: 0.4,
  },
  {
    id: 'delivering',
    icon: '✨',
    label: 'Ready!',
    status: 'complete',
    position: { bottom: '20%', right: '8%' },
    rotation: -2,
    parallaxSpeed: 0.6,
  },
];

const ROTATING_TEXTS = [
  'Automatically.',
  'While you sleep.',
  'Before you ask.',
  'On your behalf.',
];

@customElement('landing-hero')
export class LandingHero extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      min-height: 100vh;
      overflow: hidden;
      background: var(--landing-bg-dark);
    }

    /* Aurora background effect */
    .hero-background {
      position: absolute;
      inset: 0;
      z-index: 0;
      background: var(--landing-gradient-aurora);
      opacity: 0.8;
    }

    .hero-background::before {
      content: '';
      position: absolute;
      inset: 0;
      background: var(--landing-gradient-hero);
    }

    /* Animated mesh gradient */
    .hero-mesh {
      position: absolute;
      inset: 0;
      z-index: 1;
      opacity: 0.4;
      background:
        radial-gradient(circle at 20% 80%, rgba(99, 102, 241, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(168, 85, 247, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 40% 40%, rgba(45, 212, 191, 0.08) 0%, transparent 40%);
      animation: meshMove 20s ease-in-out infinite;
    }

    @keyframes meshMove {
      0%, 100% { transform: translate(0, 0) scale(1); }
      25% { transform: translate(2%, -2%) scale(1.02); }
      50% { transform: translate(-1%, 1%) scale(0.98); }
      75% { transform: translate(1%, 2%) scale(1.01); }
    }

    /* Content container */
    .hero-content {
      position: relative;
      z-index: 10;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
      text-align: center;
    }

    /* Headline */
    .hero-headline {
      font-family: var(--landing-font-display);
      font-size: clamp(2.5rem, 6vw, 4.5rem);
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.02em;
      color: var(--landing-text-primary);
      margin: 0 0 0.5rem;
      opacity: 0;
      animation: fadeInUp 0.8s ease-out 0.2s forwards;
    }

    /* Rotating text container */
    .hero-rotating {
      display: inline-block;
      min-width: 300px;
      height: 1.2em;
      overflow: hidden;
      position: relative;
    }

    .hero-rotating-text {
      display: inline-block;
      color: var(--landing-primary);
      background: linear-gradient(90deg, var(--landing-primary), var(--landing-accent-lavender));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    /* Subheadline */
    .hero-subheadline {
      max-width: 600px;
      margin: 2rem auto;
      font-size: 1.25rem;
      line-height: 1.7;
      color: var(--landing-text-secondary);
      opacity: 0;
      animation: fadeInUp 0.8s ease-out 0.4s forwards;
    }

    /* CTA buttons */
    .hero-ctas {
      display: flex;
      gap: 1rem;
      margin-top: 2rem;
      opacity: 0;
      animation: fadeInUp 0.8s ease-out 0.6s forwards;
    }

    .cta-primary {
      padding: 1rem 2rem;
      font-size: 1rem;
      font-weight: 600;
      color: white;
      background: var(--landing-primary);
      border: none;
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: var(--landing-shadow-md), var(--landing-shadow-glow);
    }

    .cta-primary:hover {
      transform: translateY(-2px);
      box-shadow: var(--landing-shadow-lg), 0 0 60px rgba(99, 102, 241, 0.4);
    }

    .cta-secondary {
      padding: 1rem 2rem;
      font-size: 1rem;
      font-weight: 600;
      color: var(--landing-text-primary);
      background: transparent;
      border: 1px solid var(--landing-border);
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .cta-secondary:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: var(--landing-border-hover);
    }

    /* Floating cards */
    .floating-card {
      position: absolute;
      z-index: 5;
      padding: 0.75rem 1rem;
      background: var(--landing-glass-bg);
      backdrop-filter: var(--landing-glass-blur);
      border: 1px solid var(--landing-glass-border);
      border-radius: 12px;
      box-shadow: var(--landing-shadow-md);
      opacity: 0;
      animation: fadeIn 0.6s ease-out forwards;
      transition: transform 0.3s ease;
    }

    .floating-card:hover {
      transform: scale(1.05) !important;
    }

    .floating-card-content {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      white-space: nowrap;
    }

    .floating-card-icon {
      font-size: 1.25rem;
    }

    .floating-card-label {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--landing-text-secondary);
    }

    .floating-card-status {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-left: 0.5rem;
    }

    .floating-card-status.active {
      background: var(--landing-accent-teal);
      animation: pulse 2s ease-in-out infinite;
    }

    .floating-card-status.complete {
      background: var(--landing-accent-warm);
    }

    /* Scroll indicator */
    .scroll-indicator {
      position: absolute;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      opacity: 0;
      animation: fadeIn 0.6s ease-out 1s forwards;
    }

    .scroll-arrow {
      width: 24px;
      height: 24px;
      color: var(--landing-text-muted);
      animation: float 2s ease-in-out infinite;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .floating-card {
        display: none;
      }

      .hero-ctas {
        flex-direction: column;
        width: 100%;
        max-width: 300px;
      }

      .cta-primary,
      .cta-secondary {
        width: 100%;
        text-align: center;
      }
    }
  `;

  @state()
  private parallaxCleanup?: () => void;

  private textRotator?: TextRotator;

  connectedCallback(): void {
    super.connectedCallback();
  }

  firstUpdated(): void {
    // Initialize parallax
    this.parallaxCleanup = initParallax(this.renderRoot as HTMLElement);

    // Initialize text rotation
    const rotatingEl = this.renderRoot.querySelector('.hero-rotating-text');
    if (rotatingEl) {
      this.textRotator = new TextRotator(
        rotatingEl as HTMLElement,
        ROTATING_TEXTS,
        3000
      );
      this.textRotator.start();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.parallaxCleanup?.();
    this.textRotator?.stop();
  }

  private renderFloatingCard(card: FloatingCard, index: number): TemplateResult {
    const style = `
      top: ${card.position.top || 'auto'};
      bottom: ${card.position.bottom || 'auto'};
      left: ${card.position.left || 'auto'};
      right: ${card.position.right || 'auto'};
      transform: rotate(${card.rotation}deg);
      --parallax-speed: ${card.parallaxSpeed};
      animation-delay: ${0.8 + index * 0.15}s;
    `;

    return html`
      <div
        class="floating-card parallax-layer"
        style=${style}
      >
        <div class="floating-card-content">
          <span class="floating-card-icon">${card.icon}</span>
          <span class="floating-card-label">${card.label}</span>
          <span class="floating-card-status ${card.status}"></span>
        </div>
      </div>
    `;
  }

  render(): TemplateResult {
    return html`
      <section class="hero">
        <div class="hero-background"></div>
        <div class="hero-mesh"></div>

        ${FLOATING_CARDS.map((card, i) => this.renderFloatingCard(card, i))}

        <div class="hero-content">
          <h1 class="hero-headline">
            Turn your ideas into reality.
          </h1>
          <div class="hero-headline hero-rotating">
            <span class="hero-rotating-text">${ROTATING_TEXTS[0]}</span>
          </div>

          <p class="hero-subheadline">
            An AI that works for you — researching, building, and delivering
            while you focus on what matters most.
          </p>

          <div class="hero-ctas">
            <button class="cta-primary" @click=${this.handleGetStarted}>
              Get Started
            </button>
            <button class="cta-secondary" @click=${this.handleLearnMore}>
              See How It Works
            </button>
          </div>
        </div>

        <div class="scroll-indicator">
          <svg class="scroll-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>
          </svg>
        </div>
      </section>
    `;
  }

  private handleGetStarted(): void {
    this.dispatchEvent(new CustomEvent('get-started', { bubbles: true, composed: true }));
  }

  private handleLearnMore(): void {
    const target = document.querySelector('#understanding-section');
    target?.scrollIntoView({ behavior: 'smooth' });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-hero': LandingHero;
  }
}
```

---

## Section 2: Understanding You

### Component Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌────────────────────────────┐  ┌────────────────────────────┐│
│  │                            │  │                            ││
│  │  An AI that truly          │  │  ┌─────────────────────┐  ││
│  │  understands you.          │  │  │   PROFILE CARD      │  ││
│  │                            │  │  │                     │  ││
│  │  Not just what you ask —   │  │  │ ┌─────┐ ┌─────────┐│  ││
│  │  but what you need.        │  │  │ │ 🎯  │ │Interests││  ││
│  │                            │  │  │ └─────┘ └─────────┘│  ││
│  │  Your interests.           │  │  │                     │  ││
│  │  Your strengths.           │  │  │ ┌────────┐ ┌──────┐│  ││
│  │  Your stressors.           │  │  │ │Strength│ │Goals ││  ││
│  │  What lights you up.       │  │  │ └────────┘ └──────┘│  ││
│  │                            │  │  │                     │  ││
│  │  The more you share,       │  │  │ ┌────────────────┐ │  ││
│  │  the more it anticipates.  │  │  │ │ Mood: Focused  │ │  ││
│  │                            │  │  │ └────────────────┘ │  ││
│  │                            │  │  │                     │  ││
│  │                            │  │  └─────────────────────┘  ││
│  │                            │  │                            ││
│  └────────────────────────────┘  └────────────────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Lit Component: Understanding Section

```typescript
// ui/src/ui/landing/sections/understanding-section.ts

import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createScrollObserver } from '../animation-utils';

interface ProfileTile {
  id: string;
  type: 'interest' | 'strength' | 'weakness' | 'goal' | 'mood';
  icon: string;
  label: string;
  color: string;
  delay: number;
}

const PROFILE_TILES: ProfileTile[] = [
  { id: 'interest-1', type: 'interest', icon: '💡', label: 'Innovation', color: 'amber', delay: 0 },
  { id: 'interest-2', type: 'interest', icon: '🎨', label: 'Design', color: 'coral', delay: 100 },
  { id: 'interest-3', type: 'interest', icon: '📚', label: 'Learning', color: 'teal', delay: 200 },
  { id: 'strength-1', type: 'strength', icon: '⚡', label: 'Quick learner', color: 'amber', delay: 300 },
  { id: 'strength-2', type: 'strength', icon: '🎯', label: 'Detail-oriented', color: 'lavender', delay: 400 },
  { id: 'goal-1', type: 'goal', icon: '🚀', label: 'Launch a product', color: 'primary', delay: 500 },
  { id: 'goal-2', type: 'goal', icon: '📈', label: 'Grow audience', color: 'teal', delay: 600 },
  { id: 'mood', type: 'mood', icon: '🧘', label: 'Focused & calm', color: 'lavender', delay: 700 },
];

@customElement('landing-understanding')
export class LandingUnderstanding extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-dark);
      padding: 8rem 2rem;
    }

    .section-container {
      max-width: 1200px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4rem;
      align-items: center;
    }

    /* Left column - Text */
    .text-column {
      opacity: 0;
      transform: translateX(-30px);
      transition: all 0.8s ease-out;
    }

    .text-column.is-visible {
      opacity: 1;
      transform: translateX(0);
    }

    .section-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--landing-primary);
      margin-bottom: 1rem;
    }

    .section-headline {
      font-size: clamp(2rem, 4vw, 3rem);
      font-weight: 700;
      line-height: 1.2;
      color: var(--landing-text-primary);
      margin: 0 0 1.5rem;
    }

    .section-body {
      font-size: 1.125rem;
      line-height: 1.8;
      color: var(--landing-text-secondary);
    }

    .section-body strong {
      color: var(--landing-text-primary);
      font-weight: 500;
    }

    .section-footnote {
      margin-top: 2rem;
      font-size: 0.875rem;
      color: var(--landing-text-muted);
      font-style: italic;
    }

    /* Right column - Profile card */
    .profile-column {
      display: flex;
      justify-content: center;
    }

    .profile-card {
      position: relative;
      width: 100%;
      max-width: 400px;
      min-height: 450px;
      padding: 2rem;
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 24px;
      box-shadow: var(--landing-shadow-lg);
    }

    .profile-card::before {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: 24px;
      background: linear-gradient(
        135deg,
        rgba(99, 102, 241, 0.3) 0%,
        transparent 50%,
        rgba(45, 212, 191, 0.2) 100%
      );
      z-index: -1;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .profile-card:hover::before {
      opacity: 1;
    }

    .profile-header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--landing-border);
    }

    .profile-avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--landing-primary), var(--landing-accent-lavender));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
    }

    .profile-name {
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--landing-text-primary);
    }

    .profile-subtitle {
      font-size: 0.875rem;
      color: var(--landing-text-muted);
    }

    /* Tiles container */
    .tiles-container {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
    }

    /* Individual tile */
    .profile-tile {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.625rem 1rem;
      background: var(--landing-bg-elevated);
      border: 1px solid var(--landing-border);
      border-radius: 100px;
      font-size: 0.875rem;
      color: var(--landing-text-secondary);
      opacity: 0;
      transform: translateY(20px) scale(0.9);
      transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .profile-tile.is-visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    .profile-tile:hover {
      transform: translateY(-2px) scale(1.02);
      border-color: var(--landing-border-hover);
    }

    .tile-icon {
      font-size: 1rem;
    }

    /* Color variants */
    .profile-tile.amber {
      border-color: rgba(245, 158, 11, 0.3);
      background: rgba(245, 158, 11, 0.1);
    }

    .profile-tile.coral {
      border-color: rgba(251, 113, 133, 0.3);
      background: rgba(251, 113, 133, 0.1);
    }

    .profile-tile.teal {
      border-color: rgba(45, 212, 191, 0.3);
      background: rgba(45, 212, 191, 0.1);
    }

    .profile-tile.lavender {
      border-color: rgba(167, 139, 250, 0.3);
      background: rgba(167, 139, 250, 0.1);
    }

    .profile-tile.primary {
      border-color: rgba(99, 102, 241, 0.3);
      background: rgba(99, 102, 241, 0.1);
    }

    /* Section dividers in profile */
    .tile-section {
      width: 100%;
      margin: 1rem 0 0.5rem;
    }

    .tile-section-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--landing-text-muted);
    }

    /* Responsive */
    @media (max-width: 900px) {
      .section-container {
        grid-template-columns: 1fr;
        gap: 3rem;
      }

      .text-column {
        text-align: center;
      }

      .profile-column {
        order: -1;
      }
    }
  `;

  @state()
  private tilesVisible = false;

  private observer?: IntersectionObserver;

  connectedCallback(): void {
    super.connectedCallback();
  }

  firstUpdated(): void {
    this.observer = createScrollObserver({ threshold: 0.3 });

    const textColumn = this.renderRoot.querySelector('.text-column');
    if (textColumn) {
      this.observer.observe(textColumn);
    }

    // Observe profile card for tile animations
    const profileCard = this.renderRoot.querySelector('.profile-card');
    if (profileCard) {
      const tileObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              this.tilesVisible = true;
              tileObserver.disconnect();
            }
          });
        },
        { threshold: 0.2 }
      );
      tileObserver.observe(profileCard);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.observer?.disconnect();
  }

  private renderTile(tile: ProfileTile): TemplateResult {
    const visibleClass = this.tilesVisible ? 'is-visible' : '';

    return html`
      <div
        class="profile-tile ${tile.color} ${visibleClass}"
        style="transition-delay: ${tile.delay}ms"
      >
        <span class="tile-icon">${tile.icon}</span>
        <span>${tile.label}</span>
      </div>
    `;
  }

  render(): TemplateResult {
    const interests = PROFILE_TILES.filter(t => t.type === 'interest');
    const strengths = PROFILE_TILES.filter(t => t.type === 'strength');
    const goals = PROFILE_TILES.filter(t => t.type === 'goal');
    const mood = PROFILE_TILES.filter(t => t.type === 'mood');

    return html`
      <section id="understanding-section">
        <div class="section-container">
          <div class="text-column animate-on-scroll">
            <span class="section-label">Personalization</span>
            <h2 class="section-headline">
              An AI that truly understands you.
            </h2>
            <p class="section-body">
              Not just what you ask — but what you <strong>need</strong>.
            </p>
            <p class="section-body">
              Your interests. Your strengths. Your stressors.
              What lights you up and what holds you back.
            </p>
            <p class="section-footnote">
              The more you share, the more it anticipates.
            </p>
          </div>

          <div class="profile-column">
            <div class="profile-card">
              <div class="profile-header">
                <div class="profile-avatar">👤</div>
                <div>
                  <div class="profile-name">Your Profile</div>
                  <div class="profile-subtitle">Always learning</div>
                </div>
              </div>

              <div class="tile-section">
                <span class="tile-section-label">Interests</span>
              </div>
              <div class="tiles-container">
                ${interests.map(t => this.renderTile(t))}
              </div>

              <div class="tile-section">
                <span class="tile-section-label">Strengths</span>
              </div>
              <div class="tiles-container">
                ${strengths.map(t => this.renderTile(t))}
              </div>

              <div class="tile-section">
                <span class="tile-section-label">Goals</span>
              </div>
              <div class="tiles-container">
                ${goals.map(t => this.renderTile(t))}
              </div>

              <div class="tile-section">
                <span class="tile-section-label">Current State</span>
              </div>
              <div class="tiles-container">
                ${mood.map(t => this.renderTile(t))}
              </div>
            </div>
          </div>
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-understanding': LandingUnderstanding;
  }
}
```

---

## Section 3: 24/7 Activity Timeline

### Lit Component

```typescript
// ui/src/ui/landing/sections/activity-section.ts

import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface ActivityEvent {
  id: string;
  time: string;
  icon: string;
  title: string;
  description: string;
  status: 'complete' | 'active';
}

const ACTIVITY_EVENTS: ActivityEvent[] = [
  {
    id: '1',
    time: '3:42 AM',
    icon: '🔍',
    title: 'Research completed',
    description: 'Analyzed 47 competitor products',
    status: 'complete',
  },
  {
    id: '2',
    time: '6:15 AM',
    icon: '📝',
    title: 'Drafted proposal',
    description: 'Business plan ready for review',
    status: 'complete',
  },
  {
    id: '3',
    time: '9:30 AM',
    icon: '🎯',
    title: 'Found 3 leads',
    description: 'Matching your criteria',
    status: 'complete',
  },
  {
    id: '4',
    time: 'Now',
    icon: '✨',
    title: 'Ready for review',
    description: 'Awaiting your approval',
    status: 'active',
  },
];

const FEATURE_CALLOUTS = [
  { icon: '🌙', title: 'Researches while you rest' },
  { icon: '💭', title: 'Drafts while you dream' },
  { icon: '☀️', title: 'Delivers when you wake' },
];

@customElement('landing-activity')
export class LandingActivity extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-elevated);
      padding: 8rem 2rem;
    }

    .section-container {
      max-width: 1000px;
      margin: 0 auto;
    }

    /* Header */
    .section-header {
      text-align: center;
      margin-bottom: 4rem;
    }

    .section-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--landing-primary);
      margin-bottom: 1rem;
    }

    .section-headline {
      font-size: clamp(2rem, 4vw, 3rem);
      font-weight: 700;
      line-height: 1.2;
      color: var(--landing-text-primary);
      margin: 0;
    }

    .section-subheadline {
      font-size: 1.25rem;
      color: var(--landing-text-muted);
      margin-top: 0.5rem;
    }

    /* Timeline */
    .timeline {
      position: relative;
      display: flex;
      justify-content: space-between;
      padding: 2rem 0;
      margin-bottom: 4rem;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .timeline::-webkit-scrollbar {
      display: none;
    }

    /* Timeline line */
    .timeline::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--landing-border);
      transform: translateY(-50%);
    }

    .timeline-line-animated {
      position: absolute;
      top: 50%;
      left: 0;
      height: 2px;
      background: linear-gradient(90deg, var(--landing-primary), var(--landing-accent-teal));
      transform: translateY(-50%);
      width: 0;
      transition: width 1.5s ease-out;
    }

    .timeline-line-animated.is-visible {
      width: 100%;
    }

    /* Timeline event */
    .timeline-event {
      position: relative;
      flex: 1;
      min-width: 200px;
      padding: 0 1rem;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.6s ease-out;
    }

    .timeline-event.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .event-card {
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 16px;
      padding: 1.5rem;
      text-align: center;
      transition: all 0.3s ease;
    }

    .event-card:hover {
      transform: translateY(-4px);
      border-color: var(--landing-border-hover);
      box-shadow: var(--landing-shadow-md);
    }

    .event-card.active {
      border-color: var(--landing-primary);
      box-shadow: var(--landing-shadow-glow);
    }

    .event-time {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--landing-text-muted);
      margin-bottom: 0.75rem;
    }

    .event-card.active .event-time {
      color: var(--landing-primary);
    }

    .event-icon {
      font-size: 2rem;
      margin-bottom: 0.75rem;
    }

    .event-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--landing-text-primary);
      margin-bottom: 0.25rem;
    }

    .event-description {
      font-size: 0.875rem;
      color: var(--landing-text-muted);
    }

    /* Status dot */
    .event-status {
      position: absolute;
      bottom: -30px;
      left: 50%;
      transform: translateX(-50%);
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--landing-bg-surface);
      border: 2px solid var(--landing-border);
      z-index: 1;
    }

    .event-status.complete {
      background: var(--landing-accent-teal);
      border-color: var(--landing-accent-teal);
    }

    .event-status.active {
      background: var(--landing-primary);
      border-color: var(--landing-primary);
      animation: pulseGlow 2s ease-in-out infinite;
    }

    /* Feature callouts */
    .callouts {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 2rem;
    }

    .callout {
      text-align: center;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.6s ease-out;
    }

    .callout.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .callout-icon {
      font-size: 2rem;
      margin-bottom: 0.75rem;
    }

    .callout-title {
      font-size: 1rem;
      font-weight: 500;
      color: var(--landing-text-secondary);
    }

    /* Responsive */
    @media (max-width: 768px) {
      .timeline {
        flex-direction: column;
        gap: 1.5rem;
      }

      .timeline::before {
        top: 0;
        bottom: 0;
        left: 50%;
        right: auto;
        width: 2px;
        height: 100%;
        transform: translateX(-50%);
      }

      .timeline-event {
        min-width: auto;
        padding: 0;
      }

      .event-status {
        left: -30px;
        bottom: auto;
        top: 50%;
        transform: translateY(-50%);
      }

      .callouts {
        grid-template-columns: 1fr;
        gap: 1.5rem;
      }
    }
  `;

  @state()
  private isVisible = false;

  firstUpdated(): void {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            this.isVisible = true;
            observer.disconnect();
          }
        });
      },
      { threshold: 0.2 }
    );

    observer.observe(this);
  }

  private renderEvent(event: ActivityEvent, index: number): TemplateResult {
    const visibleClass = this.isVisible ? 'is-visible' : '';
    const delay = index * 200;

    return html`
      <div
        class="timeline-event ${visibleClass}"
        style="transition-delay: ${delay}ms"
      >
        <div class="event-card ${event.status}">
          <div class="event-time">${event.time}</div>
          <div class="event-icon">${event.icon}</div>
          <div class="event-title">${event.title}</div>
          <div class="event-description">${event.description}</div>
        </div>
        <div class="event-status ${event.status}"></div>
      </div>
    `;
  }

  render(): TemplateResult {
    const visibleClass = this.isVisible ? 'is-visible' : '';

    return html`
      <section id="activity-section">
        <div class="section-container">
          <div class="section-header">
            <span class="section-label">Autonomous</span>
            <h2 class="section-headline">Works around the clock.</h2>
            <p class="section-subheadline">So you don't have to.</p>
          </div>

          <div class="timeline">
            <div class="timeline-line-animated ${visibleClass}"></div>
            ${ACTIVITY_EVENTS.map((event, i) => this.renderEvent(event, i))}
          </div>

          <div class="callouts">
            ${FEATURE_CALLOUTS.map((callout, i) => html`
              <div
                class="callout ${visibleClass}"
                style="transition-delay: ${800 + i * 150}ms"
              >
                <div class="callout-icon">${callout.icon}</div>
                <div class="callout-title">${callout.title}</div>
              </div>
            `)}
          </div>
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-activity': LandingActivity;
  }
}
```

---

## Section 4: Control & Guardrails

### Lit Component

```typescript
// ui/src/ui/landing/sections/control-section.ts

import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface Agent {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'pending';
  icon: string;
}

const MOCK_AGENTS: Agent[] = [
  { id: '1', name: 'Research Agent', status: 'running', icon: '🔍' },
  { id: '2', name: 'Content Agent', status: 'paused', icon: '📝' },
  { id: '3', name: 'Outreach Agent', status: 'running', icon: '📤' },
];

const TRUST_SIGNALS = [
  { icon: '🔒', label: 'End-to-end encrypted' },
  { icon: '👁', label: 'Full activity logs' },
  { icon: '✋', label: 'Approval for sensitive actions' },
];

@customElement('landing-control')
export class LandingControl extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-dark);
      padding: 8rem 2rem;
    }

    .section-container {
      max-width: 1000px;
      margin: 0 auto;
    }

    /* Header */
    .section-header {
      text-align: center;
      margin-bottom: 4rem;
    }

    .section-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--landing-primary);
      margin-bottom: 1rem;
    }

    .section-headline {
      font-size: clamp(2rem, 4vw, 3rem);
      font-weight: 700;
      line-height: 1.2;
      color: var(--landing-text-primary);
      margin: 0 0 1rem;
    }

    .section-subheadline {
      font-size: 1.125rem;
      color: var(--landing-text-secondary);
      max-width: 600px;
      margin: 0 auto;
    }

    /* Dashboard mockup */
    .dashboard {
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 20px;
      overflow: hidden;
      box-shadow: var(--landing-shadow-lg);
      opacity: 0;
      transform: translateY(30px) scale(0.98);
      transition: all 0.8s ease-out;
    }

    .dashboard.is-visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    /* Dashboard header */
    .dashboard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--landing-border);
      background: var(--landing-bg-elevated);
    }

    .dashboard-title {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--landing-text-primary);
    }

    .dashboard-title-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--landing-accent-teal);
      animation: pulse 2s ease-in-out infinite;
    }

    .dashboard-action {
      padding: 0.5rem 1rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--landing-text-muted);
      background: transparent;
      border: 1px solid var(--landing-border);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .dashboard-action:hover {
      color: var(--landing-text-primary);
      border-color: var(--landing-border-hover);
    }

    /* Dashboard body */
    .dashboard-body {
      padding: 1.5rem;
    }

    /* Agent cards grid */
    .agents-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .agent-card {
      padding: 1.25rem;
      background: var(--landing-bg-elevated);
      border: 1px solid var(--landing-border);
      border-radius: 12px;
      transition: all 0.3s ease;
    }

    .agent-card:hover {
      border-color: var(--landing-border-hover);
    }

    .agent-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .agent-icon {
      font-size: 1.5rem;
    }

    .agent-name {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--landing-text-primary);
    }

    .agent-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: var(--landing-text-muted);
      margin-bottom: 1rem;
    }

    .status-indicator {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .status-indicator.running {
      background: var(--landing-accent-teal);
    }

    .status-indicator.paused {
      background: var(--landing-accent-warm);
    }

    .agent-actions {
      display: flex;
      gap: 0.5rem;
    }

    .agent-action {
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--landing-text-muted);
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .agent-action:hover {
      color: var(--landing-text-primary);
      border-color: var(--landing-border-hover);
    }

    /* Guardrail row */
    .guardrail-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      background: var(--landing-bg-elevated);
      border: 1px solid var(--landing-border);
      border-radius: 12px;
    }

    .guardrail-content {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .guardrail-icon {
      color: var(--landing-accent-warm);
    }

    .guardrail-label {
      font-size: 0.875rem;
      color: var(--landing-text-secondary);
    }

    .guardrail-label strong {
      color: var(--landing-text-primary);
    }

    .guardrail-action {
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--landing-primary);
      background: transparent;
      border: 1px solid var(--landing-primary);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .guardrail-action:hover {
      background: rgba(99, 102, 241, 0.1);
    }

    /* Trust signals */
    .trust-signals {
      display: flex;
      justify-content: center;
      gap: 3rem;
      margin-top: 3rem;
    }

    .trust-signal {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      color: var(--landing-text-muted);
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.5s ease-out;
    }

    .trust-signal.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .trust-signal-icon {
      font-size: 1rem;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .agents-grid {
        grid-template-columns: 1fr;
      }

      .trust-signals {
        flex-direction: column;
        align-items: center;
        gap: 1rem;
      }
    }
  `;

  @state()
  private isVisible = false;

  firstUpdated(): void {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            this.isVisible = true;
            observer.disconnect();
          }
        });
      },
      { threshold: 0.2 }
    );

    observer.observe(this);
  }

  private renderAgent(agent: Agent): TemplateResult {
    const statusLabel = agent.status === 'running' ? 'Running' : 'Paused';
    const actionLabel = agent.status === 'running' ? 'View' : 'Resume';

    return html`
      <div class="agent-card">
        <div class="agent-header">
          <span class="agent-icon">${agent.icon}</span>
          <span class="agent-name">${agent.name}</span>
        </div>
        <div class="agent-status">
          <span class="status-indicator ${agent.status}"></span>
          <span>${statusLabel}</span>
        </div>
        <div class="agent-actions">
          <button class="agent-action">${actionLabel}</button>
          ${agent.status === 'running' ? html`
            <button class="agent-action">Stop</button>
          ` : ''}
        </div>
      </div>
    `;
  }

  render(): TemplateResult {
    const visibleClass = this.isVisible ? 'is-visible' : '';

    return html`
      <section id="control-section">
        <div class="section-container">
          <div class="section-header">
            <span class="section-label">Trust & Control</span>
            <h2 class="section-headline">Autonomous, not unsupervised.</h2>
            <p class="section-subheadline">
              Set the rules. Define the boundaries. Review before it acts on anything important.
            </p>
          </div>

          <div class="dashboard ${visibleClass}">
            <div class="dashboard-header">
              <div class="dashboard-title">
                <span class="dashboard-title-dot"></span>
                Active Overseers (3)
              </div>
              <button class="dashboard-action">Pause All</button>
            </div>

            <div class="dashboard-body">
              <div class="agents-grid">
                ${MOCK_AGENTS.map(agent => this.renderAgent(agent))}
              </div>

              <div class="guardrail-row">
                <div class="guardrail-content">
                  <svg class="guardrail-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                  <span class="guardrail-label">
                    <strong>Guardrail:</strong> "Never send without approval"
                  </span>
                </div>
                <button class="guardrail-action">Edit</button>
              </div>
            </div>
          </div>

          <div class="trust-signals">
            ${TRUST_SIGNALS.map((signal, i) => html`
              <div
                class="trust-signal ${visibleClass}"
                style="transition-delay: ${300 + i * 150}ms"
              >
                <span class="trust-signal-icon">${signal.icon}</span>
                <span>${signal.label}</span>
              </div>
            `)}
          </div>
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-control': LandingControl;
  }
}
```

---

## Section 5: Features Bento Grid

### Lit Component

```typescript
// ui/src/ui/landing/sections/features-section.ts

import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface Feature {
  id: string;
  icon: string;
  title: string;
  description: string;
  size: 'large' | 'medium' | 'small';
  accent?: string;
}

const FEATURES: Feature[] = [
  {
    id: 'idea-development',
    icon: '💡',
    title: 'Idea Development',
    description: 'From napkin sketch to actionable plan. Your concepts get researched, structured, and refined into something real.',
    size: 'large',
    accent: 'primary',
  },
  {
    id: 'research',
    icon: '🔍',
    title: 'Research & Discovery',
    description: 'Explores topics deeply so you don\'t have to.',
    size: 'medium',
  },
  {
    id: 'automation',
    icon: '⚙️',
    title: 'Task Automation',
    description: 'Handles operational busywork automatically.',
    size: 'medium',
  },
  {
    id: 'learning',
    icon: '📈',
    title: 'Learning & Growth',
    description: 'Surfaces insights tailored to your goals.',
    size: 'small',
  },
  {
    id: 'content',
    icon: '✍️',
    title: 'Content Creation',
    description: 'Drafts, iterates, and refines on your behalf.',
    size: 'small',
  },
  {
    id: 'integrations',
    icon: '🔗',
    title: 'External Integrations',
    description: 'Connects to your existing tools and workflows.',
    size: 'small',
  },
];

@customElement('landing-features')
export class LandingFeatures extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-elevated);
      padding: 8rem 2rem;
    }

    .section-container {
      max-width: 1100px;
      margin: 0 auto;
    }

    /* Header */
    .section-header {
      text-align: center;
      margin-bottom: 4rem;
    }

    .section-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--landing-primary);
      margin-bottom: 1rem;
    }

    .section-headline {
      font-size: clamp(2rem, 4vw, 3rem);
      font-weight: 700;
      line-height: 1.2;
      color: var(--landing-text-primary);
      margin: 0;
    }

    /* Bento grid */
    .bento-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: repeat(3, auto);
      gap: 1.25rem;
    }

    /* Feature card base */
    .feature-card {
      position: relative;
      padding: 2rem;
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 20px;
      overflow: hidden;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.6s ease-out;
    }

    .feature-card.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .feature-card:hover {
      border-color: var(--landing-border-hover);
      transform: translateY(-4px);
      box-shadow: var(--landing-shadow-md);
    }

    .feature-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 100%;
      background: var(--landing-gradient-card);
      pointer-events: none;
    }

    /* Size variants */
    .feature-card.large {
      grid-column: span 2;
      grid-row: span 2;
    }

    .feature-card.medium {
      grid-column: span 1;
      grid-row: span 1;
    }

    .feature-card.small {
      grid-column: span 1;
      grid-row: span 1;
    }

    /* Card content */
    .feature-icon {
      font-size: 2.5rem;
      margin-bottom: 1.5rem;
      opacity: 0.9;
    }

    .feature-card.large .feature-icon {
      font-size: 3.5rem;
    }

    .feature-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--landing-text-primary);
      margin-bottom: 0.75rem;
    }

    .feature-card.large .feature-title {
      font-size: 1.5rem;
    }

    .feature-description {
      font-size: 0.9375rem;
      line-height: 1.6;
      color: var(--landing-text-secondary);
    }

    .feature-card.large .feature-description {
      font-size: 1rem;
      max-width: 400px;
    }

    /* Primary accent card */
    .feature-card.accent-primary {
      border-color: rgba(99, 102, 241, 0.3);
      background: linear-gradient(
        135deg,
        rgba(99, 102, 241, 0.1) 0%,
        var(--landing-bg-surface) 50%
      );
    }

    .feature-card.accent-primary:hover {
      border-color: rgba(99, 102, 241, 0.5);
      box-shadow: var(--landing-shadow-glow);
    }

    /* Responsive */
    @media (max-width: 900px) {
      .bento-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .feature-card.large {
        grid-column: span 2;
        grid-row: span 1;
      }
    }

    @media (max-width: 600px) {
      .bento-grid {
        grid-template-columns: 1fr;
      }

      .feature-card.large,
      .feature-card.medium,
      .feature-card.small {
        grid-column: span 1;
        grid-row: span 1;
      }
    }
  `;

  @state()
  private isVisible = false;

  firstUpdated(): void {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            this.isVisible = true;
            observer.disconnect();
          }
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(this);
  }

  private renderFeatureCard(feature: Feature, index: number): TemplateResult {
    const visibleClass = this.isVisible ? 'is-visible' : '';
    const accentClass = feature.accent ? `accent-${feature.accent}` : '';
    const delay = index * 100;

    return html`
      <div
        class="feature-card ${feature.size} ${accentClass} ${visibleClass}"
        style="transition-delay: ${delay}ms"
      >
        <div class="feature-icon">${feature.icon}</div>
        <h3 class="feature-title">${feature.title}</h3>
        <p class="feature-description">${feature.description}</p>
      </div>
    `;
  }

  render(): TemplateResult {
    return html`
      <section id="features-section">
        <div class="section-container">
          <div class="section-header">
            <span class="section-label">Capabilities</span>
            <h2 class="section-headline">What Clawdbrain can do</h2>
          </div>

          <div class="bento-grid">
            ${FEATURES.map((feature, i) => this.renderFeatureCard(feature, i))}
          </div>
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-features': LandingFeatures;
  }
}
```

---

## Section 6: Social Proof & CTA

### Lit Component

```typescript
// ui/src/ui/landing/sections/social-proof-section.ts

import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface Testimonial {
  id: string;
  quote: string;
  author: string;
  role: string;
  avatar: string;
  transformation?: string;
}

const TESTIMONIALS: Testimonial[] = [
  {
    id: '1',
    quote: 'I had a business idea for years but never knew where to start. Clawdbrain researched the market, drafted a plan, and I launched in 6 weeks.',
    author: 'Sarah K.',
    role: 'First-time founder',
    avatar: 'S',
    transformation: 'Had an idea → Launched a business',
  },
  {
    id: '2',
    quote: 'It\'s like having a brilliant research assistant that never sleeps. I wake up to insights I never would have found myself.',
    author: 'Marcus T.',
    role: 'Content creator',
    avatar: 'M',
    transformation: 'Overwhelmed → In control',
  },
  {
    id: '3',
    quote: 'The proactive suggestions are uncanny. It surfaces opportunities I didn\'t even know existed for my work.',
    author: 'Elena R.',
    role: 'Freelance consultant',
    avatar: 'E',
    transformation: 'Reactive → Proactive',
  },
];

const TRUST_BADGES = [
  'No credit card required',
  'Cancel anytime',
  'Setup in 5 minutes',
];

@customElement('landing-social-proof')
export class LandingSocialProof extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    /* Testimonials section */
    .testimonials-section {
      background: var(--landing-bg-dark);
      padding: 8rem 2rem;
    }

    .section-container {
      max-width: 1100px;
      margin: 0 auto;
    }

    .section-header {
      text-align: center;
      margin-bottom: 4rem;
    }

    .section-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--landing-primary);
      margin-bottom: 1rem;
    }

    .section-headline {
      font-size: clamp(1.75rem, 3vw, 2.5rem);
      font-weight: 700;
      line-height: 1.3;
      color: var(--landing-text-primary);
      margin: 0;
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
    }

    /* Testimonials grid */
    .testimonials-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.5rem;
    }

    .testimonial-card {
      padding: 2rem;
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      border-radius: 20px;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.6s ease-out;
    }

    .testimonial-card.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .testimonial-card:hover {
      border-color: var(--landing-border-hover);
      transform: translateY(-4px);
    }

    .quote-mark {
      font-size: 3rem;
      line-height: 1;
      color: var(--landing-primary);
      opacity: 0.5;
      margin-bottom: 1rem;
    }

    .testimonial-quote {
      font-size: 1rem;
      line-height: 1.7;
      color: var(--landing-text-secondary);
      margin-bottom: 1.5rem;
    }

    .testimonial-transformation {
      display: inline-block;
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--landing-accent-teal);
      background: rgba(45, 212, 191, 0.1);
      border: 1px solid rgba(45, 212, 191, 0.3);
      border-radius: 100px;
      margin-bottom: 1.5rem;
    }

    .testimonial-author {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .author-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--landing-primary), var(--landing-accent-lavender));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      font-weight: 600;
      color: white;
    }

    .author-info {
      display: flex;
      flex-direction: column;
    }

    .author-name {
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--landing-text-primary);
    }

    .author-role {
      font-size: 0.8125rem;
      color: var(--landing-text-muted);
    }

    /* CTA section */
    .cta-section {
      background: linear-gradient(
        180deg,
        var(--landing-bg-dark) 0%,
        var(--landing-bg-elevated) 100%
      );
      padding: 8rem 2rem;
      text-align: center;
    }

    .cta-headline {
      font-size: clamp(2rem, 4vw, 3rem);
      font-weight: 700;
      line-height: 1.2;
      color: var(--landing-text-primary);
      margin: 0 0 1rem;
    }

    .cta-subheadline {
      font-size: 1.25rem;
      color: var(--landing-text-secondary);
      margin-bottom: 2.5rem;
    }

    .cta-buttons {
      display: flex;
      gap: 1rem;
      justify-content: center;
      margin-bottom: 2rem;
    }

    .cta-primary {
      padding: 1.125rem 2.5rem;
      font-size: 1.125rem;
      font-weight: 600;
      color: white;
      background: var(--landing-primary);
      border: none;
      border-radius: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: var(--landing-shadow-md), var(--landing-shadow-glow);
    }

    .cta-primary:hover {
      transform: translateY(-2px);
      box-shadow: var(--landing-shadow-lg), 0 0 60px rgba(99, 102, 241, 0.4);
    }

    .cta-secondary {
      padding: 1.125rem 2.5rem;
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--landing-text-primary);
      background: transparent;
      border: 1px solid var(--landing-border);
      border-radius: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .cta-secondary:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: var(--landing-border-hover);
    }

    .trust-badges {
      display: flex;
      gap: 2rem;
      justify-content: center;
      flex-wrap: wrap;
    }

    .trust-badge {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      color: var(--landing-text-muted);
    }

    .trust-badge-check {
      width: 16px;
      height: 16px;
      color: var(--landing-accent-teal);
    }

    /* Responsive */
    @media (max-width: 900px) {
      .testimonials-grid {
        grid-template-columns: 1fr;
        max-width: 500px;
        margin: 0 auto;
      }
    }

    @media (max-width: 600px) {
      .cta-buttons {
        flex-direction: column;
        max-width: 300px;
        margin-left: auto;
        margin-right: auto;
      }

      .trust-badges {
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
      }
    }
  `;

  @state()
  private isVisible = false;

  firstUpdated(): void {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            this.isVisible = true;
            observer.disconnect();
          }
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(this);
  }

  private renderTestimonial(testimonial: Testimonial, index: number): TemplateResult {
    const visibleClass = this.isVisible ? 'is-visible' : '';
    const delay = index * 150;

    return html`
      <div
        class="testimonial-card ${visibleClass}"
        style="transition-delay: ${delay}ms"
      >
        <div class="quote-mark">"</div>
        <p class="testimonial-quote">${testimonial.quote}</p>
        ${testimonial.transformation ? html`
          <div class="testimonial-transformation">${testimonial.transformation}</div>
        ` : ''}
        <div class="testimonial-author">
          <div class="author-avatar">${testimonial.avatar}</div>
          <div class="author-info">
            <span class="author-name">${testimonial.author}</span>
            <span class="author-role">${testimonial.role}</span>
          </div>
        </div>
      </div>
    `;
  }

  render(): TemplateResult {
    return html`
      <section id="social-proof-section">
        <div class="testimonials-section">
          <div class="section-container">
            <div class="section-header">
              <span class="section-label">Success Stories</span>
              <h2 class="section-headline">
                People are realizing dreams they didn't think were possible.
              </h2>
            </div>

            <div class="testimonials-grid">
              ${TESTIMONIALS.map((t, i) => this.renderTestimonial(t, i))}
            </div>
          </div>
        </div>

        <div class="cta-section">
          <div class="section-container">
            <h2 class="cta-headline">Ready to meet the AI that works for you?</h2>
            <p class="cta-subheadline">Start building your second brain today.</p>

            <div class="cta-buttons">
              <button class="cta-primary" @click=${this.handleGetStarted}>
                Get Started Free
              </button>
              <button class="cta-secondary" @click=${this.handleDemo}>
                Book a Demo
              </button>
            </div>

            <div class="trust-badges">
              ${TRUST_BADGES.map(badge => html`
                <div class="trust-badge">
                  <svg class="trust-badge-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                  <span>${badge}</span>
                </div>
              `)}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  private handleGetStarted(): void {
    this.dispatchEvent(new CustomEvent('get-started', { bubbles: true, composed: true }));
  }

  private handleDemo(): void {
    this.dispatchEvent(new CustomEvent('book-demo', { bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-social-proof': LandingSocialProof;
  }
}
```

---

## Footer

### Lit Component

```typescript
// ui/src/ui/landing/sections/footer-section.ts

import { html, css, LitElement, TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

const NAV_LINKS = [
  { label: 'Product', href: '#' },
  { label: 'Pricing', href: '#' },
  { label: 'Docs', href: '#' },
  { label: 'Blog', href: '#' },
  { label: 'Contact', href: '#' },
];

const SOCIAL_LINKS = [
  { icon: 'twitter', href: '#', label: 'Twitter' },
  { icon: 'github', href: '#', label: 'GitHub' },
  { icon: 'discord', href: '#', label: 'Discord' },
];

const LEGAL_LINKS = [
  { label: 'Privacy', href: '#' },
  { label: 'Terms', href: '#' },
];

@customElement('landing-footer')
export class LandingFooter extends LitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--landing-bg-dark);
      border-top: 1px solid var(--landing-border);
    }

    .footer-container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 3rem 2rem;
    }

    .footer-main {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid var(--landing-border);
    }

    .footer-logo {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--landing-text-primary);
      text-decoration: none;
    }

    .footer-logo span {
      color: var(--landing-primary);
    }

    .footer-nav {
      display: flex;
      gap: 2rem;
    }

    .footer-nav-link {
      font-size: 0.875rem;
      color: var(--landing-text-muted);
      text-decoration: none;
      transition: color 0.2s ease;
    }

    .footer-nav-link:hover {
      color: var(--landing-text-primary);
    }

    .footer-social {
      display: flex;
      gap: 1rem;
    }

    .footer-social-link {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: var(--landing-bg-surface);
      border: 1px solid var(--landing-border);
      color: var(--landing-text-muted);
      transition: all 0.2s ease;
    }

    .footer-social-link:hover {
      border-color: var(--landing-border-hover);
      color: var(--landing-text-primary);
    }

    .footer-social-icon {
      width: 18px;
      height: 18px;
    }

    .footer-bottom {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .footer-copyright {
      font-size: 0.8125rem;
      color: var(--landing-text-muted);
    }

    .footer-legal {
      display: flex;
      gap: 1.5rem;
    }

    .footer-legal-link {
      font-size: 0.8125rem;
      color: var(--landing-text-muted);
      text-decoration: none;
      transition: color 0.2s ease;
    }

    .footer-legal-link:hover {
      color: var(--landing-text-primary);
    }

    /* Responsive */
    @media (max-width: 768px) {
      .footer-main {
        flex-direction: column;
        gap: 2rem;
        text-align: center;
      }

      .footer-nav {
        flex-wrap: wrap;
        justify-content: center;
        gap: 1rem;
      }

      .footer-bottom {
        flex-direction: column;
        gap: 1rem;
        text-align: center;
      }
    }
  `;

  private renderSocialIcon(icon: string): TemplateResult {
    switch (icon) {
      case 'twitter':
        return html`
          <svg class="footer-social-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
        `;
      case 'github':
        return html`
          <svg class="footer-social-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
        `;
      case 'discord':
        return html`
          <svg class="footer-social-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
        `;
      default:
        return html``;
    }
  }

  render(): TemplateResult {
    const year = new Date().getFullYear();

    return html`
      <footer>
        <div class="footer-container">
          <div class="footer-main">
            <a href="/" class="footer-logo">
              Clawd<span>brain</span>
            </a>

            <nav class="footer-nav">
              ${NAV_LINKS.map(link => html`
                <a href=${link.href} class="footer-nav-link">${link.label}</a>
              `)}
            </nav>

            <div class="footer-social">
              ${SOCIAL_LINKS.map(link => html`
                <a
                  href=${link.href}
                  class="footer-social-link"
                  aria-label=${link.label}
                >
                  ${this.renderSocialIcon(link.icon)}
                </a>
              `)}
            </div>
          </div>

          <div class="footer-bottom">
            <p class="footer-copyright">
              © ${year} Clawdbrain. All rights reserved.
            </p>

            <div class="footer-legal">
              ${LEGAL_LINKS.map(link => html`
                <a href=${link.href} class="footer-legal-link">${link.label}</a>
              `)}
            </div>
          </div>
        </div>
      </footer>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'landing-footer': LandingFooter;
  }
}
```

---

## Responsive Breakpoints

```css
/* Add to design-system.css */

/* Breakpoint reference:
 * Mobile: < 600px
 * Tablet: 600px - 900px
 * Desktop: > 900px
 * Large: > 1200px
 */

:root {
  --landing-max-width: 1100px;
  --landing-padding-x: 2rem;
  --landing-padding-x-mobile: 1.5rem;
}

@media (max-width: 600px) {
  :root {
    --landing-padding-x: var(--landing-padding-x-mobile);
  }
}
```

---

## File Structure

```
ui/src/
├── styles/
│   ├── design-system.css          # Add landing page tokens
│   └── landing-animations.css     # NEW: Animation keyframes
└── ui/
    └── landing/
        ├── index.ts               # Main landing page component
        ├── animation-utils.ts     # Animation utilities
        └── sections/
            ├── hero-section.ts
            ├── understanding-section.ts
            ├── activity-section.ts
            ├── control-section.ts
            ├── features-section.ts
            ├── social-proof-section.ts
            └── footer-section.ts
```

---

## Implementation Tasks

### Phase 1: Foundation
1. [ ] Create `ui/src/ui/landing/` directory structure
2. [ ] Add landing page CSS tokens to `design-system.css`
3. [ ] Create `landing-animations.css` with keyframes
4. [ ] Create `animation-utils.ts` with scroll observers & parallax

### Phase 2: Core Sections
5. [ ] Implement `hero-section.ts` with floating cards & text rotation
6. [ ] Implement `understanding-section.ts` with profile mosaic
7. [ ] Implement `activity-section.ts` with animated timeline
8. [ ] Implement `control-section.ts` with dashboard mockup

### Phase 3: Feature & Social Proof
9. [ ] Implement `features-section.ts` with bento grid
10. [ ] Implement `social-proof-section.ts` with testimonials & CTA
11. [ ] Implement `footer-section.ts`

### Phase 4: Main Component & Integration
12. [ ] Create main `landing-page.ts` that composes all sections
13. [ ] Add route/view for landing page in app router
14. [ ] Test responsive behavior on all breakpoints
15. [ ] Optimize animations for performance (will-change, GPU acceleration)

### Phase 5: Polish
16. [ ] Fine-tune animation timing and easing
17. [ ] Add keyboard navigation and focus states
18. [ ] Ensure accessibility (ARIA labels, color contrast)
19. [ ] Cross-browser testing

---

## Notes

- All components use Lit's `@customElement` decorator for web component registration
- CSS uses CSS custom properties for theming consistency
- Animations use `IntersectionObserver` for scroll-triggered effects
- Parallax effects are optional and respect `prefers-reduced-motion`
- All text content is easily configurable via constants at top of each file
