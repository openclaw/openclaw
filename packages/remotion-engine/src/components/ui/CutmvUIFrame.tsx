/**
 * CutmvUIFrame — Phone/device frame wrapper for UI recreations.
 *
 * Draws a clean device chrome around children content.
 * Supports "phone" and "browser" variants.
 *
 * Usage:
 *   <CutmvUIFrame variant="phone" width={820} height={600}>
 *     <CutmvDashboardMock variant="output_config" />
 *   </CutmvUIFrame>
 */

import React from "react";

const GREEN = "#94F33F";

type FrameVariant = "phone" | "browser";

export const CutmvUIFrame: React.FC<{
  variant?: FrameVariant;
  width?: number;
  height?: number;
  children: React.ReactNode;
}> = ({ variant = "phone", width = 820, height = 600, children }) => {
  const isPhone = variant === "phone";

  return (
    <div
      style={{
        width,
        height,
        borderRadius: isPhone ? 28 : 14,
        overflow: "hidden",
        background: "#111",
        border: "2px solid rgba(255,255,255,0.08)",
        boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bar chrome */}
      <div
        style={{
          height: isPhone ? 36 : 32,
          background: "#1a1a1a",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          paddingLeft: 14,
          gap: 7,
          flexShrink: 0,
        }}
      >
        {isPhone ? (
          <>
            {/* Status bar dots */}
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                background: GREEN,
              }}
            />
            <div style={{ flex: 1 }} />
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "rgba(255,255,255,0.4)",
                fontFamily: "system-ui, sans-serif",
                marginRight: 14,
              }}
            >
              CUTMV
            </div>
          </>
        ) : (
          <>
            {/* Browser dots */}
            {["#ff5f57", "#ffbd2e", "#28c840"].map((c) => (
              <div
                key={c}
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  background: c,
                }}
              />
            ))}
            <div
              style={{
                flex: 1,
                height: 20,
                background: "#222",
                borderRadius: 6,
                marginLeft: 12,
                marginRight: 14,
                display: "flex",
                alignItems: "center",
                paddingLeft: 10,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.35)",
                  fontFamily: "system-ui, sans-serif",
                }}
              >
                app.cutmv.com
              </span>
            </div>
          </>
        )}
      </div>

      {/* Content area */}
      <div
        style={{
          flex: 1,
          overflow: "hidden",
          position: "relative",
          background: "#0a0a0a",
        }}
      >
        {children}
      </div>
    </div>
  );
};
