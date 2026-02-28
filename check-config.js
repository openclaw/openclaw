#!/usr/bin/env node
const fs = require('fs');
const path = '/data/.openclaw/openclaw.json';
const config = JSON.parse(fs.readFileSync(path, 'utf-8'));

console.log('=== AGENTS ===');
console.log(JSON.stringify(config.agents || {}, null, 2));

console.log('\n=== MODELS ===');
console.log(JSON.stringify(config.models || {}, null, 2));

console.log('\n=== ENV VARS ===');
console.log(JSON.stringify(config.env || {}, null, 2));

console.log('\n=== PLUGINS ===');
console.log(JSON.stringify(config.plugins || {}, null, 2));

console.log('\n=== GATEWAY SETTINGS ===');
console.log(JSON.stringify({
  controlUi: config.gateway?.controlUi,
  contextLimit: config.gateway?.contextLimit,
}, null, 2));
