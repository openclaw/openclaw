/**
 * Creates 9 new specs (v043–v051) with proper rich spec format.
 * Converts user-provided specs to engine-compatible JSON format.
 *
 * Usage: npx tsx scripts/create-specs-v043-v051.ts
 */
import fs from "node:fs";
import path from "node:path";

const SPECS_DIR = path.join(process.cwd(), "../../data/datasets/cutmv/motion/specs");

// Shared boilerplate for all new specs
const SHARED = {
  brand: "CUTMV",
  format: { width: 1080, height: 1920, fps: 30, durationInFrames: 450 },
  assets: {
    primaryLogo: "data/datasets/cutmv/static/brand_assets/logos/fd logo new.png",
  },
  style: {
    bg: "#0B0B0F",
    green: "#94F33F",
    backgroundLayers: [
      { type: "softGradient", opacity: 0.35, animate: "slowDrift" },
      { type: "grain", opacity: 0.18 },
      { type: "vignette", opacity: 0.55 },
      { type: "greenBloom", opacity: 0.12, pulse: "subtle" },
    ],
  },
  cursor: {
    enabled: true,
    style: "arrow_white",
    scale: 2.25,
    profile: "FAST_CLICKY",
    idleBehavior: "activeHover",
  },
  brandSystem: {
    bug: { enabled: false },
    hero: {
      enabled: true,
      heroMark: "fd_logo_new",
      placement: "center",
      openFrames: 20,
      closeFrames: 26,
      size: 140,
      scale: 1.0,
      xOffset: 0,
      yOffset: 0,
    },
    endcard: {
      enabled: true,
      style: "lockupA",
      showLastFrames: 60,
      bottomOffset: 72,
    },
  },
  transitionPresets: {},
  elementMotionPresets: {},
};

// Helper: headline line
function hl(text: string, emphasis = false) {
  return { text, emphasis };
}

// Helper: ctaEndcard headline
function eh(text: string, emphasis = true) {
  return { text, emphasis };
}

// Helper: cta button
function cta(text: string) {
  return { text, style: "solid_green" };
}

// Helper: environment shorthand
function envBlob(seed: number) {
  return { type: "abstract_blob_noise", seed };
}

function envPremiere(preset: string, seed: number) {
  return {
    type: "premiere_timeline",
    preset,
    seed,
    post: { blur: 0.7, vignette: 0.4, grain: 0.2 },
  };
}

// Helper: endcard scene (no hero/bug brandOverlay)
function endcardScene(id: string, from: number, duration: number, seed: number, headline: string, ctaText: string, footer: string) {
  return {
    id,
    type: "ctaEndcard",
    from,
    duration,
    environment: envBlob(seed),
    headline: eh(headline),
    cta: cta(ctaText),
    footer,
    brandOverlay: { hero: { enabled: false } },
  };
}

// ── v043 — BEFORE/AFTER "Manual Exports → One Upload" ──
const v043 = {
  ...SHARED,
  id: "cutmv_premium_v043",
  scenes: [
    {
      id: "s1_before",
      type: "impactText",
      from: 0,
      duration: 120,
      environment: envPremiere("music_video_dense", 43),
      contextBadge: "BEFORE",
      headlineLines: [hl("MANUAL EXPORTS."), hl("OVER AND OVER.")],
      subhead: "9:16 \u2022 1:1 \u2022 16:9 \u2022 canvas \u2022 thumbnails",
    },
    {
      id: "s2_after_configure",
      type: "uiMock",
      from: 120,
      duration: 210,
      environment: envBlob(104),
      contextBadge: "AFTER",
      uiPreset: "cutmv_configure_output_options_dark",
      uiOptions: {
        title: "CONFIGURE OUTPUTS",
        aspectPills: ["9:16", "1:1", "16:9"],
        toggles: ["CLIPS", "GIFS", "THUMBNAILS", "CANVAS"],
        cta: "GENERATE ALL",
      },
      elements: [
        {
          id: "ui",
          kind: "uiCard",
          uiPreset: "cutmv_configure_output_options_dark",
          motion: {
            enter: { type: "slideUp", at: 0, durationFrames: 16 },
            exit: { type: "fadeDown", at: 190, durationFrames: 14 },
          },
          propsTimeline: [
            { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
            { at: 18, props: { tapTarget: "toggle.gifs" } },
            { at: 24, props: { toggles: [{ label: "GIFS", on: true }] } },
            { at: 40, props: { tapTarget: "toggle.thumbnails" } },
            { at: 46, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
            { at: 64, props: { tapTarget: "toggle.canvas" } },
            { at: 70, props: { toggles: [{ label: "CANVAS", on: true }] } },
            { at: 92, props: { tapTarget: "aspect.1:1" } },
            { at: 98, props: { activeAspect: "1:1" } },
            { at: 116, props: { tapTarget: "aspect.16:9" } },
            { at: 122, props: { activeAspect: "16:9" } },
            { at: 144, props: { tapTarget: "button.start" } },
            { at: 150, props: { status: "processing", progress: 0.15 } },
            { at: 174, props: { progress: 0.62 } },
            { at: 198, props: { status: "done", progress: 1.0 } },
          ],
        },
      ],
    },
    {
      id: "s3_proof",
      type: "hookText",
      from: 330,
      duration: 60,
      environment: envBlob(12),
      contextBadge: "PROOF",
      headlineLines: [hl("ONE UPLOAD."), hl("MULTIPLE OUTPUTS.", true)],
      subhead: "Fast. Clean. Built for creators.",
    },
    endcardScene("s4_endcard", 390, 60, 5, "TRY CUTMV (BETA)", "GET STARTED", "CLIPS \u2022 GIFS \u2022 THUMBNAILS \u2022 CANVAS"),
  ],
};

// ── v044 — Speed Claim "Outputs in Seconds" ──
const v044 = {
  ...SHARED,
  id: "cutmv_premium_v044",
  scenes: [
    {
      id: "s1_hook",
      type: "hookText",
      from: 0,
      duration: 90,
      environment: envBlob(44),
      contextBadge: "BETA",
      headlineLines: [hl("OUTPUTS.", true), hl("FAST.")],
      subhead: "Stop babysitting exports.",
    },
    {
      id: "s2_speedrun_ui",
      type: "uiMock",
      from: 90,
      duration: 240,
      environment: envBlob(77),
      contextBadge: "LIVE DEMO",
      uiPreset: "cutmv_configure_output_options_dark",
      uiOptions: {
        title: "OUTPUT FORMATS",
        aspectPills: ["9:16", "1:1", "16:9"],
        toggles: ["CLIPS", "GIFS", "THUMBNAILS", "CANVAS"],
        cta: "START CREATING NOW",
      },
      elements: [
        {
          id: "ui",
          kind: "uiCard",
          uiPreset: "cutmv_configure_output_options_dark",
          motion: {
            enter: { type: "scaleUp", at: 0, durationFrames: 14 },
            exit: { type: "fadeDown", at: 224, durationFrames: 16 },
          },
          propsTimeline: [
            { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
            { at: 14, props: { tapTarget: "toggle.gifs" } },
            { at: 18, props: { toggles: [{ label: "GIFS", on: true }] } },
            { at: 30, props: { tapTarget: "toggle.thumbnails" } },
            { at: 34, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
            { at: 46, props: { tapTarget: "toggle.canvas" } },
            { at: 50, props: { toggles: [{ label: "CANVAS", on: true }] } },
            { at: 66, props: { tapTarget: "aspect.1:1" } },
            { at: 70, props: { activeAspect: "1:1" } },
            { at: 86, props: { tapTarget: "aspect.16:9" } },
            { at: 90, props: { activeAspect: "16:9" } },
            { at: 110, props: { tapTarget: "button.start" } },
            { at: 116, props: { status: "processing", progress: 0.08 } },
            { at: 146, props: { progress: 0.45 } },
            { at: 176, props: { progress: 0.82 } },
            { at: 206, props: { status: "done", progress: 1.0 } },
          ],
        },
      ],
    },
    {
      id: "s3_compare",
      type: "impactText",
      from: 330,
      duration: 60,
      environment: envPremiere("cinematic_sparse", 9),
      contextBadge: "BEFORE",
      headlineLines: [hl("WAITING ON EXPORTS"), hl("IS A TAX.", true)],
      subhead: "Cut it out of your workflow.",
    },
    endcardScene("s4_endcard", 390, 60, 2, "TRY CUTMV (BETA)", "GET FREE CREDITS", "MADE FOR REELS \u2022 TIKTOK \u2022 SHORTS"),
  ],
};

// ── v045 — "Platforms proof" + Montage ──
const v045 = {
  ...SHARED,
  id: "cutmv_premium_v045",
  scenes: [
    {
      id: "s1_platforms_hook",
      type: "hookText",
      from: 0,
      duration: 90,
      environment: envBlob(145),
      contextBadge: "BETA",
      headlineLines: [hl("MADE FOR"), hl("SHORT-FORM.", true)],
      subhead: "Reels \u2022 TikTok \u2022 Shorts",
    },
    {
      id: "s2_montage",
      type: "uiMockMontage",
      from: 90,
      duration: 150,
      environment: envBlob(33),
      contextBadge: "OUTPUTS",
      uiPreset: "cutmv_montage_dark",
      uiOptions: {
        modules: [
          { preset: "cutmv_dashboard_outputs_dark", weight: 0.4 },
          { preset: "cutmv_configure_output_options_dark", weight: 0.35 },
          { preset: "cutmv_pricing_cards_dark", weight: 0.25 },
        ],
        crossfadeFrames: 12,
      },
    },
    {
      id: "s3_configure_clicks",
      type: "uiMock",
      from: 240,
      duration: 150,
      environment: envBlob(88),
      contextBadge: "LIVE DEMO",
      uiPreset: "cutmv_configure_output_options_dark",
      uiOptions: {
        title: "PICK OUTPUTS",
        aspectPills: ["9:16", "1:1", "16:9"],
        toggles: ["CLIPS", "GIFS", "THUMBNAILS", "CANVAS"],
        cta: "GENERATE ALL",
      },
      elements: [
        {
          id: "ui",
          kind: "uiCard",
          uiPreset: "cutmv_configure_output_options_dark",
          motion: {
            enter: { type: "slideUp", at: 0, durationFrames: 16 },
            exit: { type: "fadeDown", at: 134, durationFrames: 16 },
          },
          propsTimeline: [
            { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
            { at: 16, props: { tapTarget: "aspect.1:1" } },
            { at: 22, props: { activeAspect: "1:1" } },
            { at: 34, props: { tapTarget: "aspect.16:9" } },
            { at: 40, props: { activeAspect: "16:9" } },
            { at: 56, props: { tapTarget: "toggle.gifs" } },
            { at: 62, props: { toggles: [{ label: "GIFS", on: true }] } },
            { at: 76, props: { tapTarget: "toggle.thumbnails" } },
            { at: 82, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
            { at: 98, props: { tapTarget: "button.start" } },
            { at: 104, props: { status: "processing", progress: 0.12 } },
            { at: 124, props: { progress: 0.68 } },
            { at: 144, props: { status: "done", progress: 1.0 } },
          ],
        },
      ],
    },
    endcardScene("s4_endcard", 390, 60, 6, "TRY CUTMV (BETA)", "CLAIM BETA ACCESS", "1 UPLOAD \u2192 MULTIPLE FORMATS"),
  ],
};

// ── v046 — "Objection flip" ──
const v046 = {
  ...SHARED,
  id: "cutmv_premium_v046",
  scenes: [
    {
      id: "s1_objection",
      type: "impactText",
      from: 0,
      duration: 120,
      environment: envPremiere("tutorial_talkinghead", 46),
      contextBadge: "BEFORE",
      headlineLines: [hl("RE-FRAME."), hl("EXPORT."), hl("REPEAT.", true)],
      subhead: "That\u2019s the bottleneck.",
    },
    {
      id: "s2_flip",
      type: "hookText",
      from: 120,
      duration: 60,
      environment: envBlob(20),
      contextBadge: "AFTER",
      headlineLines: [hl("NO PROBLEM.", true)],
      subhead: "Watch this.",
    },
    {
      id: "s3_ui_demo",
      type: "uiMock",
      from: 180,
      duration: 210,
      environment: envBlob(91),
      contextBadge: "LIVE DEMO",
      uiPreset: "cutmv_configure_output_options_dark",
      uiOptions: {
        title: "CONFIGURE OUTPUTS",
        aspectPills: ["9:16", "1:1", "16:9"],
        toggles: ["CLIPS", "GIFS", "THUMBNAILS", "CANVAS"],
        cta: "START CREATING NOW",
      },
      elements: [
        {
          id: "ui",
          kind: "uiCard",
          uiPreset: "cutmv_configure_output_options_dark",
          motion: {
            enter: { type: "slideUp", at: 0, durationFrames: 18 },
            exit: { type: "fadeDown", at: 192, durationFrames: 18 },
          },
          propsTimeline: [
            { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
            { at: 20, props: { tapTarget: "toggle.gifs" } },
            { at: 26, props: { toggles: [{ label: "GIFS", on: true }] } },
            { at: 44, props: { tapTarget: "toggle.canvas" } },
            { at: 50, props: { toggles: [{ label: "CANVAS", on: true }] } },
            { at: 68, props: { tapTarget: "aspect.16:9" } },
            { at: 74, props: { activeAspect: "16:9" } },
            { at: 96, props: { tapTarget: "toggle.thumbnails" } },
            { at: 102, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
            { at: 128, props: { tapTarget: "button.start" } },
            { at: 134, props: { status: "processing", progress: 0.1 } },
            { at: 166, props: { progress: 0.58 } },
            { at: 196, props: { status: "done", progress: 1.0 } },
          ],
        },
      ],
    },
    endcardScene("s4_endcard", 390, 60, 3, "TRY CUTMV (BETA)", "GET STARTED", "LESS WORK \u2022 MORE OUTPUTS"),
  ],
};

// ── v047 — "3 Steps" ──
const v047 = {
  ...SHARED,
  id: "cutmv_premium_v047",
  scenes: [
    {
      id: "s1_hook",
      type: "hookText",
      from: 0,
      duration: 90,
      environment: envBlob(47),
      contextBadge: "BETA",
      headlineLines: [hl("3 STEPS.", true), hl("DONE.")],
      subhead: "Upload \u2192 Choose outputs \u2192 Generate",
    },
    {
      id: "s2_step",
      type: "stepScene",
      from: 90,
      duration: 90,
      environment: envBlob(19),
      contextBadge: "STEP 1",
      step: { label: "UPLOAD", text: "Drop a music video once." },
      support: "No nesting. No re-frame passes.",
    },
    {
      id: "s3_ui_configure",
      type: "uiMock",
      from: 180,
      duration: 150,
      environment: envBlob(71),
      contextBadge: "STEP 2",
      uiPreset: "cutmv_configure_output_options_dark",
      uiOptions: {
        title: "PICK OUTPUTS",
        aspectPills: ["9:16", "1:1", "16:9"],
        toggles: ["CLIPS", "GIFS", "THUMBNAILS", "CANVAS"],
        cta: "GENERATE ALL",
      },
      elements: [
        {
          id: "ui",
          kind: "uiCard",
          uiPreset: "cutmv_configure_output_options_dark",
          motion: {
            enter: { type: "slideUp", at: 0, durationFrames: 18 },
            exit: { type: "fadeDown", at: 132, durationFrames: 16 },
          },
          propsTimeline: [
            { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
            { at: 22, props: { tapTarget: "toggle.gifs" } },
            { at: 28, props: { toggles: [{ label: "GIFS", on: true }] } },
            { at: 48, props: { tapTarget: "toggle.thumbnails" } },
            { at: 54, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
            { at: 78, props: { tapTarget: "toggle.canvas" } },
            { at: 84, props: { toggles: [{ label: "CANVAS", on: true }] } },
            { at: 110, props: { tapTarget: "button.start" } },
            { at: 116, props: { status: "processing", progress: 0.12 } },
            { at: 132, props: { progress: 0.62 } },
            { at: 146, props: { status: "done", progress: 1.0 } },
          ],
        },
      ],
    },
    endcardScene("s4_endcard", 330, 120, 4, "TRY CUTMV (BETA)", "GET STARTED", "UPLOAD ONCE \u2192 EXPORT EVERYWHERE"),
  ],
};

// ── v048 — "Pricing / Credits" ──
const v048 = {
  ...SHARED,
  id: "cutmv_premium_v048",
  scenes: [
    {
      id: "s1_offer_hook",
      type: "hookText",
      from: 0,
      duration: 90,
      environment: envBlob(48),
      contextBadge: "BETA",
      headlineLines: [hl("GET IN EARLY.", true), hl("GET CREDITS.")],
      subhead: "Launch pricing won\u2019t last.",
    },
    {
      id: "s2_pricing",
      type: "uiMock",
      from: 90,
      duration: 180,
      environment: envBlob(118),
      contextBadge: "PRICING",
      uiPreset: "cutmv_pricing_cards_dark",
      uiOptions: { title: "PICK A PLAN", cta: "START BETA" },
      elements: [
        {
          id: "pricing",
          kind: "uiCard",
          uiPreset: "cutmv_pricing_cards_dark",
          motion: {
            enter: { type: "scaleUp", at: 0, durationFrames: 16 },
            exit: { type: "fadeDown", at: 166, durationFrames: 14 },
          },
          propsTimeline: [
            { at: 18, props: { tapTarget: "pricing.starter" } },
            { at: 34, props: { tapTarget: "pricing.pro" } },
            { at: 50, props: { tapTarget: "pricing.business" } },
            { at: 80, props: { tapTarget: "button.start" } },
            { at: 92, props: { status: "processing", progress: 0.22 } },
            { at: 126, props: { progress: 0.78 } },
            { at: 154, props: { status: "done", progress: 1.0 } },
          ],
        },
      ],
    },
    {
      id: "s3_proof",
      type: "impactText",
      from: 270,
      duration: 60,
      environment: envPremiere("music_video_clean", 14),
      contextBadge: "BEFORE",
      headlineLines: [hl("CUT HOURS."), hl("NOT CORNERS.", true)],
      subhead: "Stop rebuilding exports manually.",
    },
    endcardScene("s4_endcard", 330, 120, 8, "TRY CUTMV (BETA)", "CLAIM FREE CREDITS", "LIMITED BETA ACCESS"),
  ],
};

// ── v049 — "Output Cards Proof" ──
const v049 = {
  ...SHARED,
  id: "cutmv_premium_v049",
  scenes: [
    {
      id: "s1_hook",
      type: "hookText",
      from: 0,
      duration: 90,
      environment: envBlob(49),
      contextBadge: "PROOF",
      headlineLines: [hl("WATCH THE OUTPUTS"), hl("POP OUT.", true)],
      subhead: "Clean deliverables. Every format.",
    },
    {
      id: "s2_outputs",
      type: "uiMock",
      from: 90,
      duration: 210,
      environment: envBlob(64),
      contextBadge: "RESULTS",
      uiPreset: "cutmv_output_cards_dark",
      uiOptions: { title: "EXPORTS READY", cta: "DOWNLOAD ALL" },
      elements: [
        {
          id: "outCards",
          kind: "uiCard",
          uiPreset: "cutmv_output_cards_dark",
          motion: {
            enter: { type: "slideUp", at: 0, durationFrames: 16 },
            exit: { type: "fadeDown", at: 194, durationFrames: 14 },
          },
          propsTimeline: [
            { at: 18, props: { tapTarget: "output.card.1" } },
            { at: 34, props: { tapTarget: "output.card.2" } },
            { at: 50, props: { tapTarget: "output.card.3" } },
            { at: 74, props: { tapTarget: "output.card.4" } },
            { at: 98, props: { tapTarget: "button.start" } },
            { at: 106, props: { status: "processing", progress: 0.18 } },
            { at: 140, props: { progress: 0.66 } },
            { at: 176, props: { status: "done", progress: 1.0 } },
          ],
        },
      ],
    },
    {
      id: "s3_compare",
      type: "impactText",
      from: 300,
      duration: 60,
      environment: envPremiere("ugc_fastcuts", 20),
      contextBadge: "BEFORE",
      headlineLines: [hl("EXPORT QUEUE"), hl("HELL.", true)],
      subhead: "Not anymore.",
    },
    endcardScene("s4_endcard", 360, 90, 9, "TRY CUTMV (BETA)", "GET STARTED", "DONE IN MINUTES \u2014 NOT HOURS"),
  ],
};

// ── v050 — "Dashboard Progress" ──
const v050 = {
  ...SHARED,
  id: "cutmv_premium_v050",
  scenes: [
    {
      id: "s1_hook",
      type: "hookText",
      from: 0,
      duration: 90,
      environment: envBlob(50),
      contextBadge: "BETA",
      headlineLines: [hl("AUTOMATE", true), hl("THE BORING PART.")],
      subhead: "Let the outputs run.",
    },
    {
      id: "s2_dashboard",
      type: "uiMock",
      from: 90,
      duration: 210,
      environment: envBlob(101),
      contextBadge: "DASHBOARD",
      uiPreset: "cutmv_dashboard_outputs_dark",
      uiOptions: { title: "RENDER QUEUE", cta: "VIEW EXPORTS" },
      elements: [
        {
          id: "dash",
          kind: "uiCard",
          uiPreset: "cutmv_dashboard_outputs_dark",
          motion: {
            enter: { type: "scaleUp", at: 0, durationFrames: 16 },
            exit: { type: "fadeDown", at: 194, durationFrames: 14 },
          },
          propsTimeline: [
            { at: 12, props: { tapTarget: "dashboard.row.1" } },
            { at: 26, props: { tapTarget: "dashboard.row.2" } },
            { at: 40, props: { tapTarget: "dashboard.row.3" } },
            { at: 60, props: { status: "processing", progress: 0.12 } },
            { at: 92, props: { progress: 0.44 } },
            { at: 124, props: { progress: 0.74 } },
            { at: 156, props: { status: "done", progress: 1.0 } },
            { at: 176, props: { tapTarget: "button.start" } },
          ],
        },
      ],
    },
    {
      id: "s3_value",
      type: "impactText",
      from: 300,
      duration: 60,
      environment: envBlob(13),
      contextBadge: "VALUE",
      headlineLines: [hl("MORE OUTPUTS.", true), hl("LESS WORK.")],
      subhead: "That\u2019s the whole point.",
    },
    endcardScene("s4_endcard", 360, 90, 7, "TRY CUTMV (BETA)", "JOIN THE BETA", "CREATORS \u2022 EDITORS \u2022 LABELS"),
  ],
};

// ── v051 — "Hard Compare" ──
const v051 = {
  ...SHARED,
  id: "cutmv_premium_v051",
  scenes: [
    {
      id: "s1_before",
      type: "impactText",
      from: 0,
      duration: 120,
      environment: envPremiere("music_video_dense", 51),
      contextBadge: "BEFORE",
      headlineLines: [hl("DUPLICATE SEQUENCES."), hl("RE-FRAME."), hl("EXPORT.", true)],
      subhead: "That\u2019s not a workflow \u2014 it\u2019s a trap.",
    },
    {
      id: "s2_after",
      type: "hookText",
      from: 120,
      duration: 60,
      environment: envBlob(22),
      contextBadge: "AFTER",
      headlineLines: [hl("CUTMV DOES IT", true), hl("FOR YOU.")],
      subhead: "Watch this.",
    },
    {
      id: "s3_ui",
      type: "uiMock",
      from: 180,
      duration: 150,
      environment: envBlob(73),
      contextBadge: "LIVE DEMO",
      uiPreset: "cutmv_configure_output_options_dark",
      uiOptions: {
        title: "OUTPUTS",
        aspectPills: ["9:16", "1:1", "16:9"],
        toggles: ["CLIPS", "GIFS", "THUMBNAILS", "CANVAS"],
        cta: "START CREATING NOW",
      },
      elements: [
        {
          id: "ui",
          kind: "uiCard",
          uiPreset: "cutmv_configure_output_options_dark",
          motion: {
            enter: { type: "slideUp", at: 0, durationFrames: 16 },
            exit: { type: "fadeDown", at: 134, durationFrames: 14 },
          },
          propsTimeline: [
            { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
            { at: 18, props: { tapTarget: "toggle.gifs" } },
            { at: 24, props: { toggles: [{ label: "GIFS", on: true }] } },
            { at: 42, props: { tapTarget: "toggle.thumbnails" } },
            { at: 48, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
            { at: 66, props: { tapTarget: "toggle.canvas" } },
            { at: 72, props: { toggles: [{ label: "CANVAS", on: true }] } },
            { at: 94, props: { tapTarget: "button.start" } },
            { at: 100, props: { status: "processing", progress: 0.08 } },
            { at: 122, props: { progress: 0.52 } },
            { at: 144, props: { status: "done", progress: 1.0 } },
          ],
        },
      ],
    },
    endcardScene("s4_endcard", 330, 120, 10, "TRY CUTMV (BETA)", "GET STARTED", "END THE EXPORT LOOP"),
  ],
};

// ── Write all 9 specs ──
const specs = [v043, v044, v045, v046, v047, v048, v049, v050, v051];

for (const spec of specs) {
  const filename = `${spec.id}.json`;
  const fp = path.join(SPECS_DIR, filename);

  // Don't overwrite existing
  if (fs.existsSync(fp)) {
    console.log(`SKIP ${filename} (already exists)`);
    continue;
  }

  fs.writeFileSync(fp, JSON.stringify(spec, null, 2) + "\n", "utf-8");
  console.log(`WROTE ${filename} (${spec.scenes.length} scenes)`);
}

console.log("\nDone. Run validate-all-specs to verify.");
