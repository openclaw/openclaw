import "./index.css";
import { Composition } from "remotion";
import specRaw from "../../../data/datasets/cutmv/motion/specs/cutmv_premium_v001.json";
import { MyComposition } from "./Composition";
// ── Engine-driven compositions (auto-generated from specs folder) ──
import { GeneratedCompositions } from "./Compositions.generated";
// ── Legacy base engine spec ──
import { CutmvPremiumAdEngine } from "./compositions/CutmvPremiumAdEngine";
import { CutmvPremiumAdV5 } from "./comps/CutmvPremiumAdV5";
import { HiggsfieldSaasProd } from "./comps/HiggsfieldSaasProd";
import { HormoziEducation } from "./comps/HormoziEducation";
import { MixedMediaScribble } from "./comps/MixedMediaScribble";
import { CutmvAd } from "./CutmvAd";
import { CutmvPremiumAd } from "./CutmvPremiumAd";
import { parseMotionSpec } from "./engine/parser/parseMotionSpec";
import { LogoOnlyTest } from "./LogoOnlyTest";
const spec = parseMotionSpec(specRaw as Record<string, unknown>);

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* ── Legacy compositions (preserved) ── */}
      <Composition
        id="MyComp"
        component={MyComposition}
        durationInFrames={150}
        fps={30}
        width={1280}
        height={720}
      />
      <Composition
        id="CutmvAd"
        component={CutmvAd}
        durationInFrames={240}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="CutmvPremiumAd"
        component={CutmvPremiumAd}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="HormoziEducation"
        component={HormoziEducation}
        durationInFrames={360}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="HiggsfieldSaasProd"
        component={HiggsfieldSaasProd}
        durationInFrames={420}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="MixedMediaScribble"
        component={MixedMediaScribble}
        durationInFrames={420}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="CutmvPremiumAdV5"
        component={CutmvPremiumAdV5}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
      />

      {/* ── Engine-driven base composition (legacy motion_specs format) ── */}
      <Composition
        id={spec.compositionId}
        component={CutmvPremiumAdEngine}
        durationInFrames={spec.durationInFrames}
        fps={spec.fps}
        width={spec.width}
        height={spec.height}
        defaultProps={{ spec }}
      />

      {/* ── Logo A/B test: renders only the brand overlay on black ── */}
      <Composition
        id="LogoOnlyTest"
        component={LogoOnlyTest}
        durationInFrames={150}
        fps={30}
        width={1080}
        height={1920}
      />

      {/* ── All 36 JSON specs auto-registered as compositions ── */}
      <GeneratedCompositions />
    </>
  );
};
