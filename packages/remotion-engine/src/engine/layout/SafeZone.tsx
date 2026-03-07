import React from "react";

export const SAFE = {
  top: 140,
  bottom: 220, // leave room for captions + CTA
  side: 70,
};

export const SafeZone: React.FC<{
  children: React.ReactNode;
  debug?: boolean;
}> = ({ children, debug }) => {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {debug ? (
        <div
          style={{
            position: "absolute",
            left: SAFE.side,
            right: SAFE.side,
            top: SAFE.top,
            bottom: SAFE.bottom,
            border: "2px dashed rgba(124,255,59,0.35)",
            borderRadius: 24,
            pointerEvents: "none",
          }}
        />
      ) : null}

      <div
        style={{
          position: "absolute",
          left: SAFE.side,
          right: SAFE.side,
          top: SAFE.top,
          bottom: SAFE.bottom,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
    </div>
  );
};
