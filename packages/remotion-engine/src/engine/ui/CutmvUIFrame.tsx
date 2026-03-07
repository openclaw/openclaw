import React from "react";

export const CutmvUIFrame: React.FC<{
  children: React.ReactNode;
  green: string;
}> = ({ children, green }) => {
  return (
    <div
      style={{
        width: 820,
        borderRadius: 28,
        background: "#0F1218",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 30px 80px rgba(0,0,0,0.65)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* green glow */}
      <div
        style={{
          position: "absolute",
          inset: -80,
          background: `radial-gradient(circle at 50% 20%, ${green}22, transparent 55%)`,
        }}
      />
      <div style={{ position: "relative", padding: 22 }}>{children}</div>
    </div>
  );
};
