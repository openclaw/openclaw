import { readFileSync } from 'fs';
const lines = readFileSync('D:/OpenClaw/Develop/openclaw/extensions/abb-robot-real-control/index.js', 'utf8').split('\n');
const total = lines.length;
console.log('Total lines:', total);
// Show last 30 lines
for (let i = Math.max(0, total-30); i < total; i++) {
  console.log(`${i+1}: ${lines[i]?.trimEnd()}`);
}
