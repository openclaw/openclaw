import { readFileSync } from 'fs';
const lines = readFileSync('D:/OpenClaw/Develop/openclaw/extensions/abb-robot-real-control/index.js', 'utf8').split('\n');
for (let i = 100; i <= 195; i++) {
  console.log(`${i+1}: ${lines[i]?.trimEnd()}`);
}
