import fs from "node:fs";
const s = JSON.parse(fs.readFileSync("../../data/datasets/cutmv/motion/specs/cutmv_premium_v036.json", "utf-8"));
console.log("Top keys:", Object.keys(s));
console.log("format:", JSON.stringify(s.format));
console.log("style:", JSON.stringify(s.style));
console.log("assets:", JSON.stringify(s.assets));
console.log("cursor:", JSON.stringify(s.cursor));
console.log("brandLockup:", JSON.stringify(s.brandLockup));
console.log("transitionPresets keys:", Object.keys(s.transitionPresets || {}));
console.log("elementMotionPresets keys:", Object.keys(s.elementMotionPresets || {}));
console.log("scenes:", s.scenes.length);
for (const sc of s.scenes) {
  console.log(`  scene ${sc.id} from:${sc.from} dur:${sc.duration} env:${sc.environment?.type}`);
  if (sc.elements) {
    for (const el of sc.elements) {
      const hasPT = el.propsTimeline ? "YES" : "no";
      console.log(`    el: ${el.id} kind:${el.kind} text:"${(el.text || "").substring(0, 40)}" propsTimeline:${hasPT}`);
    }
  }
}

// Also check v032 which has BEFORE framing
const s2 = JSON.parse(fs.readFileSync("../../data/datasets/cutmv/motion/specs/cutmv_premium_v032.json", "utf-8"));
console.log("\n--- v032 ---");
for (const sc of s2.scenes) {
  console.log(`  scene ${sc.id} from:${sc.from} dur:${sc.duration} badge:${sc.contextBadge} env:${sc.environment?.type}`);
  if (sc.elements) {
    for (const el of sc.elements) {
      const hasPT = el.propsTimeline ? `YES(${el.propsTimeline.length})` : "no";
      console.log(`    el: ${el.id} kind:${el.kind} text:"${(el.text || "").substring(0, 50)}" PT:${hasPT}`);
    }
  }
}
