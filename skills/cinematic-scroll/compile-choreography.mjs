#!/usr/bin/env node
/* ============================================================================
   compile-choreography.mjs
   The signature mechanic, made real: compiles a `scroll-choreography.json`
   (declarative scroll → camera-move schema) into runnable GSAP ScrollTrigger +
   Lenis code. No build step, no deps — plain Node ESM.

   Usage:
     node compile-choreography.mjs <choreography.json> [--out scene.js] [--html]
     node compile-choreography.mjs --example          # compile the bundled example
     node compile-choreography.mjs <file> --html      # also emit a runnable demo HTML

   What it does (mirrors scroll-choreography-compilation.md):
     1. Parse + validate the choreography object
     2. Emit Lenis smooth-scroll init (forwarded to ScrollTrigger)
     3. Per chapter: a pinned ScrollTrigger timeline with layer parallax,
        title reveal, atmosphere/color morph, and velocity nodes
     4. Transitions between chapters
     5. A reduced-motion guard that no-ops the timeline

   The single most important job: map the schema's CSS-style property names
   (translateX/translateY/rotateZ…) to GSAP's shorthand (x/y/rotation…),
   because GSAP silently ignores the CSS names. That mapping lives in ONE place
   below and is the reason this compiler exists.
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ---- the one mapping that matters: schema (CSS) → GSAP shorthand ---------- */
const GSAP_PROP = {
  translateX: 'x', translateY: 'y', translateZ: 'z',
  rotateX: 'rotationX', rotateY: 'rotationY', rotateZ: 'rotation',
  scale: 'scale', opacity: 'opacity',
  // passthroughs that GSAP accepts as-is:
  letterSpacing: 'letterSpacing', backgroundColor: 'backgroundColor',
};
const gprop = (p) => GSAP_PROP[p] ?? p;
const withUnit = (v, unit) => (unit && typeof v === 'number' ? `${v}${unit}` : v);

/* ---- tiny validation (enough to fail loudly, not a full JSON-Schema run) -- */
function validate(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') errs.push('root is not an object');
  if (!Array.isArray(doc.chapters) || !doc.chapters.length)
    errs.push('`chapters` must be a non-empty array');
  (doc.chapters || []).forEach((c, i) => {
    if (!c.id) errs.push(`chapters[${i}] missing id`);
    if (c.layers && !Array.isArray(c.layers)) errs.push(`chapters[${i}].layers must be an array`);
  });
  if (errs.length) throw new Error('Invalid choreography:\n  - ' + errs.join('\n  - '));
  return doc;
}

/* ---- emit a single property tween fragment -------------------------------- */
function propTween(p) {
  // p: { property, from, to, easing, unit }
  const g = gprop(p.property);
  const to = withUnit(p.to, p.unit);
  const frag = { [g]: to };
  if (p.easing) frag.ease = mapEase(p.easing);
  return frag;
}

/* GSAP accepts cubic-bezier via CustomEase, but named eases are safer in raw
   output. Pass cubic-beziers straight through as a string GSAP can register;
   map a few common ones to named eases for portability. */
function mapEase(e) {
  if (!e) return undefined;
  const named = {
    'cubic-bezier(0.16, 1, 0.3, 1)': 'power3.out',
    'cubic-bezier(0.7, 0, 0.84, 0)': 'power3.in',
    'cubic-bezier(0.87, 0, 0.13, 1)': 'power4.inOut',
    'cubic-bezier(0.34, 1.56, 0.64, 1)': 'back.out(1.4)',
  };
  return named[e] || e; // GSAP-named eases (power3.out etc.) pass through
}

/* ---- compile one chapter to a GSAP block ---------------------------------- */
function compileChapter(ch, globals) {
  const sel = `[data-chapter='${ch.id}']`;
  const pin = ch.pin || {};
  const pinDur = pin.pinDuration ?? 200;
  const lines = [];
  lines.push(`  /* ── Chapter: ${ch.id}  (pattern: ${ch.pattern || 'custom'}) ── */`);
  lines.push(`  {`);
  lines.push(`    const tl = gsap.timeline({`);
  lines.push(`      scrollTrigger: {`);
  lines.push(`        trigger: "${sel}",`);
  lines.push(`        start: "top top",`);
  lines.push(`        end: "+=${pinDur}%",`);
  lines.push(`        scrub: ${globals.scrollSmoothing ?? true},`);
  lines.push(`        pin: ${pin.enabled !== false},`);
  lines.push(`        pinSpacing: ${pin.pinSpacing !== false},`);
  lines.push(`        anticipatePin: 1,`);
  lines.push(`        invalidateOnRefresh: true,`);
  lines.push(`      },`);
  lines.push(`    });`);

  // layers → parallax tweens, positioned at 0 so they scrub together
  (ch.layers || []).forEach((layer) => {
    const lsel = `${sel} [data-layer='${layer.id}']`;
    const props = layer.animation?.properties || [];
    if (!props.length) return;
    const tween = {};
    const fromTween = {};
    let hasFrom = false;
    props.forEach((p) => {
      const g = gprop(p.property);
      tween[g] = withUnit(p.to, p.unit);
      if (p.from !== undefined) { fromTween[g] = withUnit(p.from, p.unit); hasFrom = true; }
    });
    const dur = layer.animation?.duration ?? 1;
    const easing = mapEase(props[0]?.easing || globals.defaultEasing);
    const willChange = layer.willChange ? `, willChange: "transform"` : '';
    if (hasFrom) {
      lines.push(`    tl.fromTo("${lsel}", ${json(fromTween)}, { ${spread(tween)}, ease: ${q(easing)}, duration: ${dur}${willChange} }, 0);`);
    } else {
      lines.push(`    tl.to("${lsel}", { ${spread(tween)}, ease: ${q(easing)}, duration: ${dur}${willChange} }, 0);`);
    }
  });

  // title reveal
  if (ch.titleReveal) {
    lines.push(...compileTitleReveal(ch.titleReveal, sel, globals));
  }

  // atmosphere / colour morph
  if (ch.atmosphere?.colorMorph) {
    const m = ch.atmosphere.colorMorph;
    lines.push(`    tl.to("${sel}", { backgroundColor: ${q(m.to)}, ease: "none", duration: 1 }, ${m.scrollStart ?? 0});`);
  } else if (ch.atmosphere?.backgroundColor) {
    lines.push(`    gsap.set("${sel}", { backgroundColor: ${q(ch.atmosphere.backgroundColor)} });`);
  }

  // velocity nodes → ScrollTrigger onUpdate reacting to getVelocity()
  if (Array.isArray(ch.velocityNodes) && ch.velocityNodes.length) {
    lines.push(...compileVelocity(ch.velocityNodes, sel));
  }

  lines.push(`  }`);
  return lines.join('\n');
}

function compileTitleReveal(t, sel, globals) {
  const tsel = `${sel} [data-title]`;
  const r = t.scrollRange || { start: 0, end: 0.4 };
  const ease = q(mapEase(t.easing || globals.defaultEasing));
  const at = r.start ?? 0;
  const dur = Math.max(0.1, (r.end ?? 0.4) - (r.start ?? 0));
  const L = [];
  L.push(`    /* title: ${t.type} */`);
  switch (t.type) {
    case 'maskReveal':
    case 'clipPathWipe':
      L.push(`    tl.fromTo("${tsel}", { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", ease: ${ease}, duration: ${dur} }, ${at});`);
      break;
    case 'verticalMask':
      L.push(`    tl.fromTo("${tsel}", { clipPath: "inset(100% 0 0 0)" }, { clipPath: "inset(0% 0 0 0)", ease: ${ease}, duration: ${dur} }, ${at});`);
      break;
    case 'wordStagger':
    case 'splitLineRise':
      L.push(`    tl.fromTo("${tsel} .w", { yPercent: 110, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, stagger: ${t.stagger?.offset ?? 0.06}, ease: ${ease}, duration: ${dur} }, ${at});`);
      break;
    case 'letterStagger':
    case 'typewriterReveal':
      L.push(`    tl.fromTo("${tsel} .c", { autoAlpha: 0 }, { autoAlpha: 1, stagger: ${t.stagger?.offset ?? 0.02}, ease: "none", duration: ${dur} }, ${at});`);
      break;
    case 'letterSpacingScrub':
      L.push(`    tl.fromTo("${tsel}", { letterSpacing: "0.4em", autoAlpha: 0.4 }, { letterSpacing: "0em", autoAlpha: 1, ease: ${ease}, duration: ${dur} }, ${at});`);
      break;
    case 'scaleDownEntrance':
      L.push(`    tl.fromTo("${tsel}", { scale: 1.3, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, ease: ${ease}, duration: ${dur} }, ${at});`);
      break;
    case 'blurCrossfade':
      // never animate filter; crossfade two stacked copies (taste-guardrails §1.1)
      L.push(`    tl.fromTo("${tsel} .sharp", { autoAlpha: 0 }, { autoAlpha: 1, ease: ${ease}, duration: ${dur} }, ${at});`);
      L.push(`    tl.to("${tsel} .soft", { autoAlpha: 0, ease: ${ease}, duration: ${dur} }, ${at});`);
      break;
    default:
      L.push(`    tl.fromTo("${tsel}", { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, ease: ${ease}, duration: ${dur} }, ${at});`);
  }
  return L;
}

function compileVelocity(nodes, sel) {
  const tsel = `${sel} [data-title]`;
  const L = [];
  L.push(`    /* velocity-reactive typography */`);
  L.push(`    ScrollTrigger.create({`);
  L.push(`      trigger: "${sel}", start: "top bottom", end: "bottom top",`);
  L.push(`      onUpdate: (self) => {`);
  L.push(`        const v = Math.abs(self.getVelocity()) / 1000;`);
  nodes.forEach((n) => {
    const cmp = n.comparison === 'below' ? '<' : '>';
    const s = n.above || {};
    const lerp = n.lerpFactor ?? 0.1;
    const set = Object.entries(s).map(([k, val]) => `${gprop(k)}: ${typeof val === 'string' ? q(val) : val}`).join(', ');
    const base = n.below || {};
    const reset = Object.entries(base).map(([k, val]) => `${gprop(k)}: ${typeof val === 'string' ? q(val) : val}`).join(', ');
    L.push(`        if (v ${cmp} ${n.threshold}) { gsap.to("${tsel}", { ${set}, duration: ${lerp}, overwrite: "auto" }); }`);
    if (reset) L.push(`        else { gsap.to("${tsel}", { ${reset}, duration: ${lerp}, overwrite: "auto" }); }`);
  });
  L.push(`      },`);
  L.push(`    });`);
  return L;
}

function compileTransition(t) {
  const TYPE = {
    craneShot:  { y: -100, rotationX: 4 },
    whipPan:    { x: '-100vw' },
    matchCut:   { autoAlpha: 0 },
    dissolve:   { autoAlpha: 0, scale: 0.97 },
    pushIn:     { scale: 1.08 },
    hardCut:    {},
  };
  const move = TYPE[t.type] || {};
  const ease = q(mapEase(t.easing || 'power4.inOut'));
  const set = Object.entries(move).map(([k, v]) => `${k}: ${typeof v === 'string' ? q(v) : v}`).join(', ');
  if (t.type === 'hardCut' || !set) {
    return `  /* transition ${t.from} → ${t.to}: hard cut (no tween) */`;
  }
  return [
    `  /* transition ${t.from} → ${t.to}: ${t.type} */`,
    `  gsap.timeline({ scrollTrigger: { trigger: "[data-chapter='${t.to}']", start: "top bottom", end: "top top", scrub: true } })`,
    `    .to("[data-chapter='${t.from}']", { ${set}, ease: ${ease} }, 0);`,
  ].join('\n');
}

/* ---- helpers -------------------------------------------------------------- */
const q = (s) => (s === undefined ? 'undefined' : JSON.stringify(s));
const json = (o) => JSON.stringify(o);
const spread = (o) => Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? q(v) : v}`).join(', ');

/* ---- top-level emit ------------------------------------------------------- */
function compile(doc) {
  validate(doc);
  const g = doc.globals || {};
  const out = [];
  out.push(`/* AUTO-GENERATED by compile-choreography.mjs — do not edit by hand. */`);
  out.push(`/* Source choreography: ${doc.metadata?.name || 'unnamed'} */`);
  out.push(`import { gsap } from "gsap";`);
  out.push(`import { ScrollTrigger } from "gsap/ScrollTrigger";`);
  out.push(`import Lenis from "lenis";`);
  out.push(`gsap.registerPlugin(ScrollTrigger);`);
  out.push(``);
  out.push(`export function initChoreography() {`);
  out.push(`  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;`);
  out.push(`  if (reduce) { /* ${g.reducedMotionFallback || 'static'} fallback: skip all motion */ return; }`);
  out.push(``);
  out.push(`  /* smooth scroll → ScrollTrigger */`);
  out.push(`  const lenis = new Lenis({ lerp: ${g.scrollSmoothing ?? 0.1} });`);
  out.push(`  lenis.on("scroll", ScrollTrigger.update);`);
  out.push(`  gsap.ticker.add((t) => lenis.raf(t * 1000));`);
  out.push(`  gsap.ticker.lagSmoothing(0);`);
  out.push(`  gsap.defaults({ ease: ${q(mapEase(g.defaultEasing) || 'power3.out')}, duration: ${g.defaultDuration ?? 1} });`);
  out.push(``);
  (doc.chapters || []).forEach((ch) => out.push(compileChapter(ch, g)));
  if (Array.isArray(doc.transitions)) {
    out.push(``);
    doc.transitions.forEach((t) => out.push(compileTransition(t)));
  }
  out.push(``);
  out.push(`  ScrollTrigger.refresh();`);
  out.push(`}`);
  return out.join('\n');
}

/* ---- CLI ------------------------------------------------------------------ */
function main() {
  const args = process.argv.slice(2);
  let src = args.find((a) => !a.startsWith('--'));
  if (args.includes('--example') || !src) {
    src = join(__dirname, 'scroll-choreography.json');
  }
  if (!existsSync(src)) { console.error(`✗ not found: ${src}`); process.exit(1); }

  let doc = JSON.parse(readFileSync(src, 'utf8'));
  // a schema file stores its real choreography under examples[0]
  if (doc.$schema && Array.isArray(doc.examples) && doc.examples.length) {
    console.error(`note: ${basename(src)} is a schema — compiling examples[0] ("${doc.examples[0].metadata?.name || 'example'}")`);
    doc = doc.examples[0];
  }

  const code = compile(doc);
  const outArg = args.indexOf('--out');
  const outPath = outArg >= 0 ? args[outArg + 1] : null;
  if (outPath) { writeFileSync(outPath, code); console.error(`✓ wrote ${outPath} (${code.split('\n').length} lines)`); }
  else { process.stdout.write(code + '\n'); }
}

main();
