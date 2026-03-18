import { readFileSync } from 'fs';
const lines = readFileSync('D:/OpenClaw/Develop/openclaw/extensions/abb-robot-real-control/index.js', 'utf8').split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('timeout') || lines[i].includes('15000') || lines[i].includes('runPowerShell')) {
    console.log(`${i+1}: ${lines[i].trimEnd()}`);
  }
}
