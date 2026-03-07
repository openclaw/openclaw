import { MotionSpec } from "./MotionSpecTypes";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`MotionSpec validation failed: ${msg}`);
}

export function validateMotionSpec(spec: MotionSpec) {
  assert(
    spec.width === 1080 && spec.height === 1920,
    "Must be 1080x1920 for CutmvPremiumAd",
  );
  assert(spec.durationInFrames > 0, "durationInFrames must be > 0");
  assert(spec.fps === 30, "fps must be 30 (engine default)");

  // ── Brand governance ──
  assert(
    spec.assets.primaryLogo,
    "primaryLogo is required",
  );

  // HARD: Block CUTMV logo entirely — use Full Digital only
  const p = spec.assets.primaryLogo.toLowerCase();
  assert(
    !p.includes("cutmv-logo"),
    "CUTMV logo disabled: use FULL DIGITAL logo only for now",
  );

  // ── Timeline checks ──
  for (const s of spec.scenes) {
    assert(s.from >= 0, `scene ${s.id} from must be >=0`);
    assert(s.duration > 0, `scene ${s.id} duration must be >0`);
    assert(
      s.from + s.duration <= spec.durationInFrames,
      `scene ${s.id} exceeds duration`,
    );

    // Legacy transition bounds
    if (s.transitionOut) {
      assert(
        s.transitionOut.duration > 0 &&
          s.transitionOut.duration <= s.duration,
        `scene ${s.id} transitionOut duration invalid`,
      );
    }

    // Enhanced transition bounds
    if (s.enhancedTransitionOut) {
      assert(
        s.enhancedTransitionOut.duration > 0 &&
          s.enhancedTransitionOut.duration <= s.duration,
        `scene ${s.id} enhancedTransitionOut duration invalid`,
      );
    }
    if (s.transitionIn) {
      assert(
        s.transitionIn.duration > 0 &&
          s.transitionIn.duration <= s.duration,
        `scene ${s.id} transitionIn duration invalid`,
      );
    }

    // Element timeline validation
    if (s.elements) {
      for (const el of s.elements) {
        assert(el.id, `element in scene ${s.id} missing id`);
        assert(
          el.motion.enter.at >= 0,
          `element ${el.id} enter.at must be >= 0`,
        );
        if (el.motion.exit) {
          assert(
            el.motion.exit.at >= el.motion.enter.at,
            `element ${el.id} exit.at must be >= enter.at`,
          );
        }

        // propsTimeline validation
        if (el.propsTimeline) {
          assert(
            el.kind === "uiCard",
            `element ${el.id}: propsTimeline only valid on uiCard elements`,
          );
          let prevAt = -1;
          for (const entry of el.propsTimeline) {
            assert(
              entry.at >= 0,
              `element ${el.id}: propsTimeline entry.at must be >= 0`,
            );
            assert(
              entry.at > prevAt,
              `element ${el.id}: propsTimeline entries must be in ascending order`,
            );
            prevAt = entry.at;
            if (entry.props.progress !== undefined) {
              assert(
                entry.props.progress >= 0 && entry.props.progress <= 1,
                `element ${el.id}: progress must be 0-1`,
              );
            }
            if (entry.props.status !== undefined) {
              assert(
                ["idle", "processing", "generating", "done"].includes(entry.props.status),
                `element ${el.id}: status must be idle|processing|generating|done`,
              );
            }
            if (entry.props.highlightToggleIndex !== undefined) {
              assert(
                entry.props.highlightToggleIndex >= 0,
                `element ${el.id}: highlightToggleIndex must be >= 0`,
              );
            }
          }
        }
      }
    }
  }

  // ── UI preset naming ──
  for (const s of spec.scenes) {
    if (s.type === "uiMock" || s.type === "uiMockMontage") {
      const presetName =
        s.type === "uiMock" ? s.uiPreset : s.uiPreset;
      assert(
        presetName.startsWith("cutmv_"),
        `scene ${s.id}: uiPreset "${presetName}" must start with "cutmv_"`,
      );
    }
    // Validate uiPreset on uiCard elements
    if (s.elements) {
      for (const el of s.elements) {
        if (el.kind === "uiCard" && el.uiPreset) {
          assert(
            el.uiPreset.startsWith("cutmv_"),
            `element ${el.id}: uiPreset "${el.uiPreset}" must start with "cutmv_"`,
          );
        }
      }
    }
  }

  // ── Legibility gates ──
  for (const s of spec.scenes) {
    if (
      (s.type === "hookText" || s.type === "impactText") &&
      !s.elements // only enforce for legacy non-element scenes
    ) {
      assert(
        s.headlineLines.length <= 2,
        `scene ${s.id}: max 2 headline lines (got ${s.headlineLines.length})`,
      );
    }
  }

  // ── Background layers ──
  if (spec.backgroundLayers) {
    const validTypes = ["softGradient", "grain", "vignette", "greenBloom"];
    for (const layer of spec.backgroundLayers) {
      assert(
        validTypes.includes(layer.type),
        `Unknown background layer type: ${layer.type}`,
      );
      assert(
        layer.opacity >= 0 && layer.opacity <= 1,
        `Background layer ${layer.type} opacity must be 0-1`,
      );
    }
  }

  // ── Captions ──
  if (spec.captions?.enabled) {
    for (const c of spec.captions.segments) {
      assert(c.from >= 0 && c.to > c.from, "caption segment invalid range");
    }
  }
}
