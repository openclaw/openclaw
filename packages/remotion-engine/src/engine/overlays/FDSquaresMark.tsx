/**
 * FDSquaresMark — Inline SVG rendering of the Full Digital squares logo mark.
 *
 * Uses a 3x3 grid with two cells removed to create the distinctive cluster.
 * Pure SVG — no PNG alpha / GPU compositing issues.
 */
import React from "react";

export const FDSquaresMark: React.FC<{
  size?: number;
  color?: string;
  gap?: number;
  radius?: number;
}> = ({ size = 28, color = "#FFFFFF", gap = 3, radius = 2 }) => {
  // 3x3 grid with top-left and bottom-right removed
  const cells = [
    [0, 1, 1],
    [1, 1, 1],
    [1, 1, 0],
  ];

  const gridN = 3;
  const cell = (size - gap * (gridN - 1)) / gridN;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        display: "block",
        shapeRendering: "geometricPrecision",
      }}
    >
      {cells.map((row, r) =>
        row.map((on, c) => {
          if (on === 0) return null;
          const x = c * (cell + gap);
          const y = r * (cell + gap);
          return (
            <rect
              key={`${r}-${c}`}
              x={x}
              y={y}
              width={cell}
              height={cell}
              rx={radius}
              fill={color}
            />
          );
        }),
      )}
    </svg>
  );
};
