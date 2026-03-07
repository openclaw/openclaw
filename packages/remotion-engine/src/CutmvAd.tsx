import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

export const CutmvAd: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const SEC = fps; // frames per second

  // ── Scene 1: Headline (0.3s–4.0s) ──
  const headlineEnterFrame = 0.3 * SEC;
  const headlineExitFrame = 4.0 * SEC;
  const headlineFadeDuration = 0.6 * SEC;

  const headlineOpacity = interpolate(
    frame,
    [
      headlineEnterFrame,
      headlineEnterFrame + headlineFadeDuration,
      headlineExitFrame - headlineFadeDuration,
      headlineExitFrame,
    ],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // ── Scene 2: CTA (4.3s–end) ──
  const ctaEnterFrame = 4.3 * SEC;
  const ctaFadeDuration = 0.6 * SEC;

  const ctaOpacity = interpolate(
    frame,
    [ctaEnterFrame, ctaEnterFrame + ctaFadeDuration],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#000000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
      }}
    >
      {/* Scene 1: Headline */}
      <div
        style={{
          position: "absolute",
          width: "80%",
          textAlign: "center",
          opacity: headlineOpacity,
        }}
      >
        <span
          style={{
            color: "#FFFFFF",
            fontSize: 72,
            fontWeight: 700,
            fontFamily:
              "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
            lineHeight: 1.15,
            letterSpacing: "0.02em",
          }}
        >
          TURN YOUR MUSIC VIDEO INTO CLIPS
        </span>
      </div>

      {/* Scene 2: CTA */}
      <div
        style={{
          position: "absolute",
          width: "80%",
          textAlign: "center",
          opacity: ctaOpacity,
        }}
      >
        <span
          style={{
            color: "#FFFFFF",
            fontSize: 100,
            fontWeight: 700,
            fontFamily:
              "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
            lineHeight: 1.15,
            letterSpacing: "0.02em",
          }}
        >
          TRY CUTMV
        </span>
      </div>
    </div>
  );
};
