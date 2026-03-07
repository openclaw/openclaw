import React from "react";

export const NoOverlapStack: React.FC<{
  children: React.ReactNode;
  gap?: number;
  align?: "center" | "start";
  maxWidth?: number;
}> = ({ children, gap = 22, align = "center", maxWidth = 980 }) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap,
        alignItems: align === "center" ? "center" : "flex-start",
        width: "100%",
        maxWidth,
        margin: "0 auto",
      }}
    >
      {children}
    </div>
  );
};
