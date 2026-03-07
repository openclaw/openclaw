import React from "react";

// ── Toggle constants ──
const TOGGLE_W = 44;
const TOGGLE_H = 26;
const KNOB_SIZE = 22;
const KNOB_OFF = 2;
const KNOB_ON = 20;

export const ConfigureOutputCard: React.FC<{
  title: string;
  quickStart: boolean;
  aspectPills: string[];
  toggles: string[];
  cta: string;
  green: string;
  // ── Optional drivable state (undefined → static defaults) ──
  activePillIndex?: number;
  toggleOn?: boolean[];
  pressed?: boolean;
  progress?: number;
  status?: "idle" | "generating" | "done";
  highlightToggleIndex?: number;
  checkmarks?: string[];
  // Animation sub-props (for smooth tweening)
  knobPositions?: number[];   // per-toggle knob left position (KNOB_OFF..KNOB_ON)
  trackColors?: string[];     // per-toggle track color
  trackOpacities?: number[];  // per-toggle track opacity
  ctaScale?: number;          // CTA button transform scale
  ctaGlow?: number;           // CTA glow intensity (0..1)
  checkmarkScales?: number[]; // per-toggle checkmark scale (0..1)
}> = ({
  title,
  aspectPills,
  toggles,
  cta,
  green,
  activePillIndex,
  toggleOn,
  pressed: _pressed,
  progress,
  status,
  highlightToggleIndex,
  checkmarks,
  knobPositions,
  trackColors,
  trackOpacities,
  ctaScale,
  ctaGlow,
  checkmarkScales,
}) => {
  // Resolve pill index: if undefined, default to 0 (backward compat)
  const pillIdx = activePillIndex ?? 0;

  // Resolve progress bar
  const progressPct = progress ?? 0;
  const showProgress =
    status === "generating" || status === "done" || progressPct > 0;

  // Resolve CTA state
  const scale = ctaScale ?? 1;
  const glow = ctaGlow ?? 0;
  const glowShadow =
    glow > 0 ? `0 0 ${Math.round(40 * glow)}px ${green}44` : "none";

  return (
    <div
      style={{
        color: "white",
        fontFamily: "system-ui, -apple-system, Segoe UI, Inter, Arial",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 800, opacity: 0.9 }}>
        {title}
      </div>

      <div
        style={{
          marginTop: 14,
          padding: 14,
          borderRadius: 18,
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 800 }}>QUICK START</div>
        <div style={{ marginTop: 6, fontSize: 13, opacity: 0.75 }}>
          AUTO-GENERATE CLIPS BASED ON VIDEO LENGTH
        </div>
      </div>

      {/* Aspect Ratio pills */}
      <div
        style={{
          marginTop: 16,
          fontSize: 13,
          fontWeight: 800,
          opacity: 0.7,
        }}
      >
        ASPECT RATIO
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        {aspectPills.map((p, idx) => {
          const isActive = idx === pillIdx;
          return (
            <div
              key={idx}
              style={{
                padding: "10px 14px",
                borderRadius: 999,
                fontWeight: 900,
                fontSize: 12,
                background: isActive
                  ? `${green}22`
                  : "rgba(255,255,255,0.06)",
                border: isActive
                  ? `1px solid ${green}88`
                  : "1px solid rgba(255,255,255,0.08)",
              }}
            >
              {p}
            </div>
          );
        })}
      </div>

      {/* Output Formats toggles */}
      <div
        style={{
          marginTop: 18,
          fontSize: 13,
          fontWeight: 800,
          opacity: 0.7,
        }}
      >
        OUTPUT FORMATS
      </div>
      <div
        style={{
          marginTop: 10,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {toggles.map((t, idx) => {
          // Determine toggle ON state
          const isOn = toggleOn ? (toggleOn[idx] ?? false) : idx === 0;
          // Knob position: driven or derived from isOn
          const knobLeft =
            knobPositions?.[idx] ?? (isOn ? KNOB_ON : KNOB_OFF);
          // Track color
          const tColor = trackColors?.[idx] ?? (isOn ? green : "rgba(255,255,255,0.12)");
          // Track opacity
          const tOpacity = trackOpacities?.[idx] ?? 1;
          // Highlight
          const isHighlighted = highlightToggleIndex === idx;
          // Checkmark
          const hasCheckmark = checkmarks?.includes(t) ?? false;
          const checkScale = checkmarkScales?.[idx] ?? (hasCheckmark ? 1 : 0);

          return (
            <div
              key={idx}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 14px",
                borderRadius: 14,
                background: isHighlighted
                  ? "rgba(255,255,255,0.10)"
                  : "rgba(255,255,255,0.06)",
                border: isHighlighted
                  ? `1px solid ${green}44`
                  : "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontWeight: 900 }}>{t}</div>
                {hasCheckmark && checkScale > 0 && (
                  <div
                    style={{
                      fontSize: 16,
                      color: green,
                      transform: `scale(${checkScale})`,
                      transformOrigin: "center",
                    }}
                  >
                    &#10003;
                  </div>
                )}
              </div>
              <div
                style={{
                  width: TOGGLE_W,
                  height: TOGGLE_H,
                  borderRadius: 999,
                  background: tColor,
                  opacity: tOpacity,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    width: KNOB_SIZE,
                    height: KNOB_SIZE,
                    borderRadius: 999,
                    background: "white",
                    position: "absolute",
                    top: 2,
                    left: knobLeft,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Progress bar */}
      {showProgress && (
        <div
          style={{
            marginTop: 14,
            height: 6,
            borderRadius: 999,
            background: "rgba(255,255,255,0.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.round(progressPct * 100)}%`,
              height: "100%",
              borderRadius: 999,
              background: green,
            }}
          />
        </div>
      )}

      {/* CTA Button */}
      <div
        style={{
          marginTop: 16,
          padding: "14px 16px",
          borderRadius: 16,
          background: green,
          color: "#0B0B0F",
          fontWeight: 1000,
          textAlign: "center",
          transform: `scale(${scale})`,
          boxShadow: glowShadow,
        }}
      >
        {cta}
      </div>
    </div>
  );
};
