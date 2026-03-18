import { readFileSync } from 'fs';
const lines = readFileSync('D:/OpenClaw/Develop/openclaw/extensions/abb-robot-real-control/index.js', 'utf8').split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('movj') || lines[i].includes('MoveToJoints') || lines[i].includes('motionTimeout') || lines[i].includes('waitRapidIdle')) {
    console.log(`${i+1}: ${lines[i].trimEnd()}`);
  }
}
