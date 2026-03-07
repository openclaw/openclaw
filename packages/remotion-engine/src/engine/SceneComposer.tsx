import React from "react";
import { AbsoluteFill, Img, Sequence, useCurrentFrame } from "remotion";
import { NoOverlapStack } from "./layout/NoOverlapStack";
import { SafeZone } from "./layout/SafeZone";
import { ElementAnimator } from "./motion/ElementAnimator";
import { MotionSpec, SceneSpec, ElementDef } from "./parser/MotionSpecTypes";
import { CtaEndcardRenderer } from "./scenes/CtaEndcardScene";
import { FeatureGridRenderer } from "./scenes/FeatureGridScene";
// Scene renderers (backward compat for scenes without elements[])
import { FeatureListRenderer } from "./scenes/FeatureListScene";
import { StepSceneRenderer } from "./scenes/StepScene";
import { renderUIPreset } from "./scenes/UIMockScene";
import { UIMockRenderer, UIMockMontageRenderer } from "./scenes/UIMockScene";
import { ConfigureOutputCard } from "./ui/ConfigureOutputCard";
import { CutmvUIFrame } from "./ui/CutmvUIFrame";
import { InteractiveConfigPanel } from "./ui/InteractiveConfigPanel";
import { tapTargetToCardCoords } from "./ui/maps/tapTargetToCoords";
import { OutputCardStack } from "./ui/OutputCardStack";
import { resolveTimeline, findTapStartFrame } from "./ui/resolveTimeline";
import { TapRipple } from "./ui/TapRipple";

// ── Headline with dedup + subhead support (backward compat) ──
const Headline: React.FC<{
  lines: { text: string; color: "white" | "green"; underline?: boolean }[];
  green: string;
  subhead?: string;
}> = ({ lines, green, subhead }) => {
  const frame = useCurrentFrame();
  const pop = (i: number) => {
    const t = Math.max(0, Math.min(1, (frame - i * 8) / 10));
    return 0.96 + t * 0.04;
  };

  // Dedup: remove duplicate lines
  const unique = lines.filter((l, idx) => lines.findIndex((x) => x.text === l.text) === idx);

  const subT = Math.max(0, Math.min(1, (frame - unique.length * 8 - 4) / 12));
  const subEase = 1 - Math.pow(1 - subT, 3);

  return (
    <NoOverlapStack maxWidth={920}>
      {unique.map((l, i) => (
        <div
          key={i}
          style={{
            fontSize: 72,
            fontWeight: 1000,
            letterSpacing: 0.5,
            transform: `scale(${pop(i)})`,
            opacity: 1,
            textAlign: "center",
            width: "100%",
          }}
        >
          <span style={{ color: l.color === "green" ? green : "white" }}>{l.text}</span>
          {l.underline ? (
            <div
              style={{
                margin: "10px auto 0",
                width: 520,
                height: 6,
                background: green,
                borderRadius: 999,
              }}
            />
          ) : null}
        </div>
      ))}
      {subhead ? (
        <div
          style={{
            fontSize: 30,
            fontWeight: 700,
            color: "rgba(255,255,255,0.55)",
            textAlign: "center",
            opacity: subEase,
            transform: `translateY(${(1 - subEase) * 12}px)`,
          }}
        >
          {subhead}
        </div>
      ) : null}
    </NoOverlapStack>
  );
};

// ── Interactive uiCard wrapper (React component — can use hooks) ──
const InteractiveUICardElement: React.FC<{
  el: ElementDef;
  green: string;
}> = ({ el, green }) => {
  const frame = useCurrentFrame();
  const timeline = el.propsTimeline!;
  const resolved = resolveTimeline(frame, timeline);
  const options = el.uiOptions ?? {};

  const toggleLabels = (options.outputs as string[]) ?? ["CLIPS", "GIFS", "THUMBNAILS", "CANVAS"];
  const aspectPills = (options.aspectToggles as string[]) ?? ["9:16", "1:1", "16:9"];

  // ── Ripple: prefer tapTarget-based coords, fall back to raw tap{x,y} ──
  let rippleX: number | undefined;
  let rippleY: number | undefined;
  let rippleStartFrame = -1;

  if (resolved.tapTarget) {
    // Use semantic tapTarget → pixel-perfect card-local coords
    const coords = tapTargetToCardCoords(resolved.tapTarget, toggleLabels, aspectPills);
    rippleX = coords.x;
    rippleY = coords.y;
    rippleStartFrame = findTapStartFrame(frame, timeline);
  } else if (resolved.tap) {
    // Fall back to raw tap{x,y} (backward compat with v003)
    rippleX = resolved.tap.x;
    rippleY = resolved.tap.y;
    rippleStartFrame = findTapStartFrame(frame, timeline);
  }

  // Scene-level cursor DISABLED — GlobalCursorOverlay handles all cursor rendering
  // to prevent double-cursor. Only ripple stays at card level (visually correct).

  return (
    <div style={{ position: "relative" }}>
      <CutmvUIFrame green={green}>
        <InteractiveConfigPanel
          green={green}
          title={(options.title as string) ?? "CONFIGURE OUTPUT OPTIONS"}
          aspectPills={aspectPills}
          toggles={toggleLabels}
          cta={(options.primaryButton as string) ?? "START CREATING NOW"}
          toggleStates={resolved.toggles ?? []}
          activeAspect={resolved.activeAspect ?? 0}
          pressed={resolved.pressed ?? false}
          progress={resolved.progress ?? 0}
          status={resolved.status ?? "idle"}
          checkmarks={resolved.checkmarks ?? []}
          frame={frame}
          timeline={timeline}
          highlightToggleIndex={resolved.highlightToggleIndex}
        />
      </CutmvUIFrame>
      {/* Ripple at tap location (stays at card level for correct clipping) */}
      {rippleX !== undefined && rippleY !== undefined && rippleStartFrame >= 0 ? (
        <TapRipple x={rippleX} y={rippleY} startFrame={rippleStartFrame} currentFrame={frame} />
      ) : null}
    </div>
  );
};

// ── Render a single element by kind ──
function renderElement(
  el: ElementDef,
  green: string,
  black: string,
  primaryLogo: string,
): React.ReactNode {
  switch (el.kind) {
    case "headline":
      return (
        <div
          style={{
            fontSize: 72,
            fontWeight: 1000,
            letterSpacing: 0.5,
            textAlign: "center",
            color: el.emphasis ? green : "white",
            width: "100%",
          }}
        >
          {el.text}
        </div>
      );

    case "subhead":
      return (
        <div
          style={{
            fontSize: 30,
            fontWeight: 700,
            color: "rgba(255,255,255,0.55)",
            textAlign: "center",
          }}
        >
          {el.text}
        </div>
      );

    case "accentUnderline":
      return (
        <div
          style={{
            width: 520,
            height: 6,
            background: green,
            borderRadius: 999,
            margin: "0 auto",
          }}
        />
      );

    case "uiCard":
      if (el.propsTimeline && el.propsTimeline.length > 0) {
        return <InteractiveUICardElement el={el} green={green} />;
      }
      return renderUIPreset(
        el.uiPreset ?? "cutmv_configure_output_options_dark",
        el.uiOptions ?? {},
        green,
      );

    case "cta":
      return (
        <div
          style={{
            display: "inline-block",
            padding: "18px 44px",
            borderRadius: 18,
            background: green,
            color: black,
            fontSize: 28,
            fontWeight: 1000,
            letterSpacing: 1,
            textAlign: "center",
          }}
        >
          {el.text}
        </div>
      );

    case "badge":
      return (
        <div
          style={{
            display: "inline-block",
            padding: "8px 20px",
            borderRadius: 12,
            background: green,
            color: black,
            fontSize: 20,
            fontWeight: 900,
            letterSpacing: 1,
          }}
        >
          {el.text}
        </div>
      );

    case "logo":
      return <Img src={primaryLogo} style={{ height: 92, objectFit: "contain" }} />;

    case "support":
      return (
        <div
          style={{
            fontSize: 24,
            fontWeight: 600,
            color: "rgba(255,255,255,0.45)",
            textAlign: "center",
          }}
        >
          {el.text}
        </div>
      );

    case "listItem":
      return (
        <div
          style={{
            fontSize: 42,
            fontWeight: 800,
            color: "white",
            textAlign: "center",
          }}
        >
          {el.text}
        </div>
      );

    case "gridItem":
      return (
        <div
          style={{
            fontSize: 36,
            fontWeight: 800,
            color: "white",
            textAlign: "center",
          }}
        >
          {el.text}
        </div>
      );

    default:
      return el.text ? <div style={{ color: "white", fontSize: 30 }}>{el.text}</div> : null;
  }
}

// ── Element-based scene rendering (new path) ──
function renderElementScene(scene: SceneSpec, spec: MotionSpec): React.ReactNode {
  const green = spec.style.green;
  const black = spec.style.black;
  const logo = spec.assets.primaryLogo;
  const elements = scene.elements!;

  return (
    <SafeZone>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        {elements.map((el) => (
          <ElementAnimator key={el.id} motion={el.motion} presets={spec.elementMotionPresets}>
            {renderElement(el, green, black, logo)}
          </ElementAnimator>
        ))}
      </div>
    </SafeZone>
  );
}

// ── Legacy scene rendering (backward compat) ──
function renderScene(scene: SceneSpec, spec: MotionSpec): React.ReactNode {
  // New element-driven path
  if (scene.elements && scene.elements.length > 0) {
    return renderElementScene(scene, spec);
  }

  // Legacy renderers
  const green = spec.style.green;

  if (scene.type === "hookText" || scene.type === "impactText") {
    return (
      <SafeZone>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Headline lines={scene.headlineLines} green={green} subhead={scene.subhead} />
        </div>
      </SafeZone>
    );
  }

  if (scene.type === "uiBlock") {
    if (scene.ui.component === "ConfigureOutputCard") {
      const p = scene.ui.props as {
        title: string;
        quickStart: boolean;
        aspectPills: string[];
        toggles: string[];
        cta: string;
      };
      return (
        <SafeZone>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CutmvUIFrame green={green}>
              <ConfigureOutputCard green={green} {...p} />
            </CutmvUIFrame>
          </div>
        </SafeZone>
      );
    }
    if (scene.ui.component === "OutputCardStack") {
      const p = scene.ui.props as { cards: { label: string; credits: number }[] };
      return (
        <SafeZone>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <OutputCardStack green={green} {...p} />
          </div>
        </SafeZone>
      );
    }
  }

  if (scene.type === "uiMock") {
    return <UIMockRenderer scene={scene} green={green} />;
  }
  if (scene.type === "uiMockMontage") {
    return <UIMockMontageRenderer scene={scene} green={green} />;
  }
  if (scene.type === "featureList") {
    return <FeatureListRenderer scene={scene} green={green} />;
  }
  if (scene.type === "featureGrid") {
    return <FeatureGridRenderer scene={scene} green={green} />;
  }
  if (scene.type === "stepScene") {
    return <StepSceneRenderer scene={scene} green={green} />;
  }
  if (scene.type === "ctaEndcard") {
    return <CtaEndcardRenderer scene={scene} green={green} black={spec.style.black} />;
  }

  // Blank scene — renders nothing (used for logoOnly outro window)
  if (scene.type === "blank") {
    return null;
  }

  if (scene.type === "ctaEnd") {
    return (
      <SafeZone>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <NoOverlapStack maxWidth={920}>
            <div style={{ fontSize: 80, fontWeight: 1000, color: "white", textAlign: "center" }}>
              {scene.cta.primary}
            </div>
            <div style={{ fontSize: 80, fontWeight: 1000, color: "white", textAlign: "center" }}>
              {scene.cta.secondary}
            </div>
            <div
              style={{
                marginTop: 8,
                display: "inline-block",
                padding: "18px 26px",
                borderRadius: 18,
                background: spec.style.green,
                color: spec.style.black,
                fontWeight: 1000,
              }}
            >
              {scene.cta.button}
            </div>
          </NoOverlapStack>
        </div>
      </SafeZone>
    );
  }

  return null;
}

// ── SceneComposer: renders scene content only (transitions moved to CutmvAdEngine) ──
export const SceneComposer: React.FC<{ spec: MotionSpec }> = ({ spec }) => {
  return (
    <AbsoluteFill style={{ zIndex: 10 }}>
      {spec.scenes.map((s) => (
        <Sequence key={s.id} from={s.from} durationInFrames={s.duration}>
          {renderScene(s, spec)}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
