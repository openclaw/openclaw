import plugin from '../extensions/abb-robot-real-control/index.js';

let tool;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  {
    controllerHost: '127.0.0.1',
    controllerPort: 7000,
    bridgeDllPath: 'd:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll',
  }
);

// Test connect with allowVirtualController=true
const r = await tool.execute('test', {
  action: 'connect',
  host: '127.0.0.1',
  port: 7000,
  allowVirtualController: true
});
console.log('connect result:', JSON.stringify(r?.details ?? r, null, 2));
console.log('text:', r?.content?.[0]?.text);
