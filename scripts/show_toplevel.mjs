import { readFileSync } from 'fs';
const lines = readFileSync('D:/OpenClaw/Develop/openclaw/extensions/abb-robot-real-control/index.js', 'utf8').split('\n');
// Show first 50 lines (top-level code)
for (let i = 0; i < 50; i++) {
  console.log(`${i+1}: ${lines[i]?.trimEnd()}`);
}
