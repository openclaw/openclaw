import { readFileSync } from 'fs';
const lines = readFileSync('D:/OpenClaw/Develop/openclaw/extensions/abb-robot-real-control/index.js', 'utf8').split('\n');
for (let i = 451; i <= 510; i++) {
  console.log(`${i+1}: ${lines[i]?.trimEnd()}`);
}
