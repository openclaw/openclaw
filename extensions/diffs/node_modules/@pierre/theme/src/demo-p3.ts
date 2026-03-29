// src/demo-p3.ts
// Demonstration of Display P3 color conversion with enhancement

import { srgbHexToP3Color } from "./color-p3";

console.log("Display P3 Color Conversion Demo");
console.log("=".repeat(70));
console.log("");

const testColors = [
  { name: "Blue", srgb: "#008cff" },
  { name: "Green", srgb: "#0dbe4e" },
  { name: "Red", srgb: "#ff2e3f" },
  { name: "Purple", srgb: "#c635e4" },
  { name: "Pink", srgb: "#fc2b73" },
  { name: "Orange", srgb: "#fe8c2c" },
  { name: "Cyan", srgb: "#08c0ef" },
  { name: "Teal", srgb: "#00c5d2" }
];

console.log("Color conversions from sRGB to Enhanced Display P3:");
console.log("(Enhanced to take advantage of P3's wider gamut)");
console.log("");

for (const { name, srgb } of testColors) {
  const p3Basic = srgbHexToP3Color(srgb, false);
  const p3Enhanced = srgbHexToP3Color(srgb, true);
  console.log(`${name.padEnd(10)} ${srgb}`);
  console.log(`${''.padEnd(10)} Basic:    ${p3Basic}`);
  console.log(`${''.padEnd(10)} Enhanced: ${p3Enhanced}`);
  console.log("");
}

console.log("=".repeat(70));
console.log("");
console.log("Enhancement Details:");
console.log("- Saturation boost: 15-30% depending on original saturation");
console.log("- Luminance boost: 5% for highly saturated colors");
console.log("- Grays and near-blacks/whites are left unchanged");
console.log("");
console.log("These enhanced colors take full advantage of Display P3's");
console.log("wider color gamut (~25% more colors than sRGB).");
console.log("");
console.log("Browser support: Safari 10+, Chrome 111+, Firefox 113+, Edge 111+");
