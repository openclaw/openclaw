import React from "react";

export const OutputCardStack: React.FC<{
  cards: { label: string; credits: number }[];
  green: string;
}> = ({ cards, green }) => {
  return (
    <div style={{ width: 820, height: 520, position: "relative" }}>
      {cards.map((c, i) => {
        const rot = [-8, 5, -3][i] ?? 0;
        const y = [140, 220, 300][i] ?? 140;
        const x = [40, 110, 70][i] ?? 40;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: 620,
              padding: 18,
              borderRadius: 20,
              background: "white",
              color: "#111",
              transform: `rotate(${rot}deg)`,
              boxShadow: `0 30px 90px rgba(0,0,0,0.55), 0 0 40px ${green}33`,
              border: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 18 }}>{c.label}</div>
            <div style={{ marginTop: 6, opacity: 0.7, fontWeight: 700 }}>
              PACK OF 5 &bull; {c.credits} CREDITS
            </div>
            <div
              style={{
                marginTop: 10,
                width: 44,
                height: 26,
                borderRadius: 999,
                background: "rgba(0,0,0,0.12)",
                position: "relative",
              }}
            >
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: "white",
                  position: "absolute",
                  top: 2,
                  left: 2,
                  boxShadow: "0 4px 10px rgba(0,0,0,0.2)",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
