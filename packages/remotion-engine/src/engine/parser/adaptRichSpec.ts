/**
 * adaptRichSpec — Normalizes a "rich" MotionSpec JSON (with format/rules/style
 * fields from the spec pack) into the engine-compatible MotionSpec shape.
 *
 * Handles:
 * - format.width/height/fps/durationInFrames → top-level
 * - style.bg → style.bg + defaults for grain/vignette/black/card
 * - headlineLines with {emphasis:bool} → {color:"white"|"green"}
 * - brand string normalization ("CUTMV" → "cutmv")
 * - compositionId from spec.id
 * - Enhanced transitions: transitionIn, enhancedTransitionOut, elements[]
 * - Background layers and preset maps
 */
import {
  MotionSpec,
  SceneSpec,
  HeadlineLine,
  EnhancedTransitionSpec,
  ElementDef,
} from "./MotionSpecTypes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptRichSpec(raw: any): MotionSpec {
  // Top-level fields
  const format = raw.format ?? {};
  const style = raw.style ?? {};
  const assets = raw.assets ?? {};
  const brandRaw = (raw.brand ?? "cutmv") as string;

  const spec: MotionSpec = {
    brand: brandRaw.toLowerCase() === "fulldigital" ? "fulldigital" : "cutmv",
    compositionId: (raw.id ?? raw.compositionId ?? "CutmvPremiumAdEngine").replace(/_/g, "-"),
    fps: format.fps ?? raw.fps ?? 30,
    width: format.width ?? raw.width ?? 1080,
    height: format.height ?? raw.height ?? 1920,
    durationInFrames:
      format.durationInFrames ?? raw.durationInFrames ?? 300,
    seed: raw.seed ?? 1337,
    assets: {
      primaryLogo:
        assets.primaryLogo ??
        "brands/cutmv/datasets/static/brand_assets/logos/fd logo new.png",
      demoFrameDir: assets.demoFrameDir,
    },
    style: {
      bg: style.bg ?? "#0B0B0F",
      grain: style.grain ?? 0.04,
      vignette: style.vignette ?? true,
      green: style.green ?? "#94F33F",
      black: style.black ?? style.bg ?? "#0B0B0F",
      card: style.card ?? "#111318",
    },
    scenes: (raw.scenes ?? []).map(adaptScene),
    captions: raw.captions,

    // New fields
    cursor: raw.cursor,
    brandLockup: raw.brandLockup,
    brandSystem: raw.brandSystem,
    backgroundLayers: style.backgroundLayers ?? raw.backgroundLayers,
    transitionPresets: raw.transitionPresets,
    elementMotionPresets: raw.elementMotionPresets,
  };

  return spec;
}

// ── Auto-upgrade old transitionOut → enhancedTransitionOut ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adaptTransition(t: any): EnhancedTransitionSpec | undefined {
  if (!t) return undefined;
  if (t.coverage) return t as EnhancedTransitionSpec; // already enhanced

  // Route "glitch" to clean "dipFade" (no banding)
  if (t.type === "glitch") {
    return {
      type: "dipFade",
      coverage: "full",
      duration: t.duration ?? 12,
      dipColor: "#060608",
      easing: "easeInOutCubic",
      out: { opacityTo: 0, blurToPx: 6, scaleTo: 1.01 },
      mid: { holdFrames: 2, dipOpacity: 1.0 },
      in: { opacityFrom: 0, blurFromPx: 6, scaleFrom: 1.01 },
      antiBanding: { grainOpacity: 0.10, dither: true },
    };
  }

  // Upgrade simple {type, duration} to full-matte wipe/sweep
  return {
    type: t.type ?? "wipe",
    coverage: "full",
    direction: t.type === "sweep" ? "diagUp" : "leftToRight",
    duration: t.duration ?? 12,
    overscanPx: 160,
    featherPx: 44,
    easing: "easeInOutCubic",
    addGlowEdge: true,
    edgeGlowOpacity: 0.22,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adaptScene(s: any): SceneSpec {
  const base = {
    id: s.id,
    from: s.from,
    duration: s.duration,
    transitionOut: s.transitionOut,
    transitionIn: s.transitionIn as EnhancedTransitionSpec | undefined,
    enhancedTransitionOut:
      s.enhancedTransitionOut ?? adaptTransition(s.transitionOut),
    elements: s.elements?.map(adaptElement),
    environment: s.environment,
    contextBadge: s.contextBadge,
    brandOverlay: s.brandOverlay,
  };

  // hookText / impactText — normalize headlineLines
  if (s.type === "hookText" || s.type === "impactText") {
    return {
      ...base,
      type: s.type,
      headlineLines: (s.headlineLines ?? []).map(adaptHeadlineLine),
      subhead: s.subhead,
    };
  }

  // Pass through known engine types unchanged
  if (s.type === "uiBlock") return { ...base, type: "uiBlock", ui: s.ui };
  if (s.type === "ctaEnd") return { ...base, type: "ctaEnd", cta: s.cta };

  // Rich spec types — pass through with their own fields
  if (s.type === "uiMock") {
    return {
      ...base,
      type: "uiMock",
      uiPreset: s.uiPreset,
      uiOptions: s.uiOptions ?? {},
      layout: s.layout,
    };
  }

  if (s.type === "uiMockMontage") {
    return {
      ...base,
      type: "uiMockMontage",
      uiPreset: s.uiPreset,
      uiOptions: s.uiOptions ?? { modules: [] },
      layout: s.layout,
    };
  }

  if (s.type === "featureList") {
    return {
      ...base,
      type: "featureList",
      title: s.title,
      title2: s.title2,
      items: s.items ?? [],
      layout: s.layout,
      motion: s.motion,
    };
  }

  if (s.type === "featureGrid") {
    return {
      ...base,
      type: "featureGrid",
      title: s.title,
      items: s.items ?? [],
      layout: s.layout,
      motion: s.motion,
    };
  }

  if (s.type === "stepScene") {
    return {
      ...base,
      type: "stepScene",
      step: s.step,
      support: s.support,
    };
  }

  if (s.type === "ctaEndcard") {
    return {
      ...base,
      type: "ctaEndcard",
      logo: s.logo,
      headline: s.headline,
      headline2: s.headline2,
      subhead: s.subhead,
      cta: s.cta,
      footer: s.footer,
    };
  }

  // Blank scene (empty — used for logoOnly outro window)
  if (s.type === "blank") {
    return { ...base, type: "blank" };
  }

  // Fallback: treat unknown as hookText with empty lines
  return {
    ...base,
    type: "hookText",
    headlineLines: [],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adaptElement(e: any): ElementDef {
  return {
    id: e.id,
    kind: e.kind,
    text: e.text,
    emphasis: e.emphasis,
    uiPreset: e.uiPreset,
    uiOptions: e.uiOptions,
    slot: e.slot,
    templateId: e.templateId,
    asset: e.asset,
    motion: e.motion,
    propsTimeline: e.propsTimeline,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adaptHeadlineLine(l: any): HeadlineLine {
  // Rich spec uses {text, emphasis:bool} — engine uses {text, color:"white"|"green"}
  if (l.color) return l as HeadlineLine;
  return {
    text: l.text ?? "",
    color: l.emphasis ? "green" : "white",
    underline: l.underline ?? l.emphasis ?? false,
  };
}
