import fs from "node:fs";
import path from "node:path";

const dir = "../../data/datasets/cutmv/motion/specs";
const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();

const ctaTexts = new Set<string>();
const supportTexts = new Set<string>();
const headlineTexts = new Set<string>();

for (const file of files) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
  for (const scene of spec.scenes) {
    if (!scene.id) continue;
    if (!scene.id.includes("cta") && !scene.id.includes("endcard")) continue;
    for (const el of scene.elements || []) {
      if (el.kind === "cta") ctaTexts.add(el.text);
      if (el.kind === "support") supportTexts.add(el.text);
      if (el.kind === "headline") headlineTexts.add(el.text);
    }
  }
}

console.log("CTA button texts:", [...ctaTexts]);
console.log("Support/footer texts:", [...supportTexts]);
console.log("Headlines:", [...headlineTexts]);
