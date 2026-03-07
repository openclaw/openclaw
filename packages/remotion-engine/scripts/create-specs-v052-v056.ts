/**
 * Create specs v052-v056 — 336 frames (11.2s), logoOnly outro.
 *
 * Pattern: hook (72f) → before/premiere (66f) → ui demo (138f) → blank outro (60f)
 * brandSystem: hero disabled, endcard logoOnly, showLastFrames 60
 *
 * Usage: npx tsx scripts/create-specs-v052-v056.ts
 */
import fs from "node:fs";
import path from "node:path";

const SPECS_DIR = path.join(process.cwd(), "brands/cutmv/datasets/motion/specs");

type RawHeadline = { text: string; emphasis: boolean };

type SpecDef = {
  id: string;
  scenes: any[];
};

const shared = {
  brand: "CUTMV",
  format: { width: 1080, height: 1920, fps: 30, durationInFrames: 336 },
  assets: {
    primaryLogo: "brands/cutmv/datasets/static/brand_assets/logos/fd logo new.png",
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
      enabled: false,  // no logo at start for logoOnly mode
      heroMark: "fd_logo_new",
      placement: "center",
      openFrames: 20,
      closeFrames: 26,
      size: 140,
      scale: 1,
      xOffset: 0,
      yOffset: 0,
    },
    endcard: {
      enabled: true,
      style: "logoOnly",
      showLastFrames: 60,
      heroMark: "fd_logo_new",
      size: 140,
    },
  },
  transitionPresets: {},
  elementMotionPresets: {},
};

function h(text: string, emphasis: boolean): RawHeadline {
  return { text, emphasis };
}

const specs: SpecDef[] = [
  {
    id: "cutmv_premium_v052",
    scenes: [
      {
        id: "s1_hook",
        type: "hookText",
        from: 0,
        duration: 72,
        environment: { type: "abstract_blob_noise", seed: 52 },
        headlineLines: [h("STOP WASTING", false), h("YOUR EDITS.", true)],
        subhead: "Your timeline deserves better.",
      },
      {
        id: "s2_before",
        type: "impactText",
        from: 72,
        duration: 66,
        environment: {
          type: "premiere_timeline",
          preset: "music_video_dense",
          seed: 52,
          post: { blur: 0.7, vignette: 0.4, grain: 0.2 },
        },
        contextBadge: "BEFORE",
        headlineLines: [h("EXPORT. RE-FRAME.", false), h("REPEAT.", true)],
        subhead: "Sound familiar?",
      },
      {
        id: "s3_ui",
        type: "uiMock",
        from: 138,
        duration: 138,
        environment: { type: "abstract_blob_noise", seed: 53 },
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
              exit: { type: "fadeDown", at: 122, durationFrames: 14 },
            },
            propsTimeline: [
              { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
              { at: 18, props: { tapTarget: "toggle.gifs" } },
              { at: 24, props: { toggles: [{ label: "GIFS", on: true }] } },
              { at: 42, props: { tapTarget: "toggle.thumbnails" } },
              { at: 48, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
              { at: 66, props: { tapTarget: "toggle.canvas" } },
              { at: 72, props: { toggles: [{ label: "CANVAS", on: true }] } },
              { at: 88, props: { tapTarget: "button.start" } },
              { at: 94, props: { status: "processing", progress: 0.08 } },
              { at: 110, props: { progress: 0.52 } },
              { at: 128, props: { status: "done", progress: 1 } },
            ],
          },
        ],
      },
      {
        id: "s4_outro",
        type: "blank",
        from: 276,
        duration: 60,
        environment: { type: "none" },
      },
    ],
  },
  {
    id: "cutmv_premium_v053",
    scenes: [
      {
        id: "s1_hook",
        type: "hookText",
        from: 0,
        duration: 72,
        environment: { type: "abstract_blob_noise", seed: 54 },
        headlineLines: [h("ONE VIDEO.", true), h("EVERY FORMAT.", false)],
        subhead: "No re-exports. No re-frames.",
      },
      {
        id: "s2_before",
        type: "impactText",
        from: 72,
        duration: 66,
        environment: {
          type: "premiere_timeline",
          preset: "short_form_quick",
          seed: 55,
          post: { blur: 0.7, vignette: 0.4, grain: 0.2 },
        },
        contextBadge: "BEFORE",
        headlineLines: [h("MANUAL EXPORTS", false), h("KILL MOMENTUM.", true)],
        subhead: "Three formats = three timelines.",
      },
      {
        id: "s3_ui",
        type: "uiMock",
        from: 138,
        duration: 138,
        environment: { type: "abstract_blob_noise", seed: 56 },
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
              exit: { type: "fadeDown", at: 122, durationFrames: 14 },
            },
            propsTimeline: [
              { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
              { at: 20, props: { tapTarget: "toggle.gifs" } },
              { at: 26, props: { toggles: [{ label: "GIFS", on: true }] } },
              { at: 44, props: { tapTarget: "toggle.thumbnails" } },
              { at: 50, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
              { at: 68, props: { tapTarget: "toggle.canvas" } },
              { at: 74, props: { toggles: [{ label: "CANVAS", on: true }] } },
              { at: 90, props: { tapTarget: "button.start" } },
              { at: 96, props: { status: "processing", progress: 0.1 } },
              { at: 114, props: { progress: 0.6 } },
              { at: 130, props: { status: "done", progress: 1 } },
            ],
          },
        ],
      },
      {
        id: "s4_outro",
        type: "blank",
        from: 276,
        duration: 60,
        environment: { type: "none" },
      },
    ],
  },
  {
    id: "cutmv_premium_v054",
    scenes: [
      {
        id: "s1_hook",
        type: "hookText",
        from: 0,
        duration: 72,
        environment: { type: "abstract_blob_noise", seed: 57 },
        headlineLines: [h("YOUR EDITS", false), h("DESERVE MORE.", true)],
        subhead: "Every frame. Every format. Instant.",
      },
      {
        id: "s2_speed",
        type: "impactText",
        from: 72,
        duration: 66,
        environment: { type: "abstract_blob_noise", seed: 58 },
        headlineLines: [h("4 FORMATS.", true), h("30 SECONDS.", false)],
        subhead: "Not 4 hours. Not 4 exports.",
      },
      {
        id: "s3_ui",
        type: "uiMock",
        from: 138,
        duration: 138,
        environment: { type: "abstract_blob_noise", seed: 59 },
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
              exit: { type: "fadeDown", at: 122, durationFrames: 14 },
            },
            propsTimeline: [
              { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
              { at: 16, props: { tapTarget: "toggle.gifs" } },
              { at: 22, props: { toggles: [{ label: "GIFS", on: true }] } },
              { at: 38, props: { tapTarget: "toggle.thumbnails" } },
              { at: 44, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
              { at: 60, props: { tapTarget: "toggle.canvas" } },
              { at: 66, props: { toggles: [{ label: "CANVAS", on: true }] } },
              { at: 82, props: { tapTarget: "button.start" } },
              { at: 88, props: { status: "processing", progress: 0.05 } },
              { at: 106, props: { progress: 0.55 } },
              { at: 126, props: { status: "done", progress: 1 } },
            ],
          },
        ],
      },
      {
        id: "s4_outro",
        type: "blank",
        from: 276,
        duration: 60,
        environment: { type: "none" },
      },
    ],
  },
  {
    id: "cutmv_premium_v055",
    scenes: [
      {
        id: "s1_hook",
        type: "hookText",
        from: 0,
        duration: 72,
        environment: { type: "abstract_blob_noise", seed: 60 },
        headlineLines: [h("EDITORS HATE", true), h("THE EXPORT LOOP.", false)],
        subhead: "Here's the fix.",
      },
      {
        id: "s2_before",
        type: "impactText",
        from: 72,
        duration: 66,
        environment: {
          type: "premiere_timeline",
          preset: "documentary_long",
          seed: 61,
          post: { blur: 0.7, vignette: 0.4, grain: 0.2 },
        },
        contextBadge: "IN EDITOR",
        headlineLines: [h("SAME TIMELINE.", false), h("DIFFERENT CROP.", true)],
        subhead: "Over and over and over.",
      },
      {
        id: "s3_ui",
        type: "uiMock",
        from: 138,
        duration: 138,
        environment: { type: "abstract_blob_noise", seed: 62 },
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
              exit: { type: "fadeDown", at: 122, durationFrames: 14 },
            },
            propsTimeline: [
              { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
              { at: 22, props: { tapTarget: "toggle.gifs" } },
              { at: 28, props: { toggles: [{ label: "GIFS", on: true }] } },
              { at: 46, props: { tapTarget: "toggle.thumbnails" } },
              { at: 52, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
              { at: 70, props: { tapTarget: "toggle.canvas" } },
              { at: 76, props: { toggles: [{ label: "CANVAS", on: true }] } },
              { at: 92, props: { tapTarget: "button.start" } },
              { at: 98, props: { status: "processing", progress: 0.08 } },
              { at: 116, props: { progress: 0.48 } },
              { at: 132, props: { status: "done", progress: 1 } },
            ],
          },
        ],
      },
      {
        id: "s4_outro",
        type: "blank",
        from: 276,
        duration: 60,
        environment: { type: "none" },
      },
    ],
  },
  {
    id: "cutmv_premium_v056",
    scenes: [
      {
        id: "s1_hook",
        type: "hookText",
        from: 0,
        duration: 72,
        environment: { type: "abstract_blob_noise", seed: 63 },
        headlineLines: [h("BUILT FOR", false), h("CREATORS.", true)],
        subhead: "Not render farms.",
      },
      {
        id: "s2_objection",
        type: "impactText",
        from: 72,
        duration: 66,
        environment: { type: "abstract_blob_noise", seed: 64 },
        headlineLines: [h("\"TOO COMPLEX.\"", false), h("NOT ANYMORE.", true)],
        subhead: "Pick formats. Hit go. Done.",
      },
      {
        id: "s3_ui",
        type: "uiMock",
        from: 138,
        duration: 138,
        environment: { type: "abstract_blob_noise", seed: 65 },
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
              exit: { type: "fadeDown", at: 122, durationFrames: 14 },
            },
            propsTimeline: [
              { at: 0, props: { activeAspect: "9:16", toggles: [{ label: "CLIPS", on: true }] } },
              { at: 14, props: { tapTarget: "toggle.gifs" } },
              { at: 20, props: { toggles: [{ label: "GIFS", on: true }] } },
              { at: 36, props: { tapTarget: "toggle.thumbnails" } },
              { at: 42, props: { toggles: [{ label: "THUMBNAILS", on: true }] } },
              { at: 58, props: { tapTarget: "toggle.canvas" } },
              { at: 64, props: { toggles: [{ label: "CANVAS", on: true }] } },
              { at: 80, props: { tapTarget: "button.start" } },
              { at: 86, props: { status: "processing", progress: 0.1 } },
              { at: 104, props: { progress: 0.5 } },
              { at: 124, props: { status: "done", progress: 1 } },
            ],
          },
        ],
      },
      {
        id: "s4_outro",
        type: "blank",
        from: 276,
        duration: 60,
        environment: { type: "none" },
      },
    ],
  },
];

let written = 0;
for (const def of specs) {
  const full = { ...shared, ...def };
  const fp = path.join(SPECS_DIR, `${def.id}.json`);
  fs.writeFileSync(fp, JSON.stringify(full, null, 2) + "\n", "utf-8");
  written++;
  console.log(`Wrote ${def.id}`);
}

console.log(`\nCreated ${written} specs (336f, logoOnly outro).`);
