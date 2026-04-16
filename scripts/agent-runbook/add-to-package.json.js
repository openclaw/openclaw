#!/usr/bin/env node
/**
 * Add runbook generator script to package.json
 */

import fs from 'node:fs';
import path from 'node:url';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../..');

const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

// Add script to package.json
packageJson.scripts = packageJson.scripts || {};
packageJson.scripts['runbook:generate'] = 'node --import tsx scripts/agent-runbook/generator.ts';
packageJson.scripts['runbook:schedule'] = 'node --import tsx scripts/agent-runbook/cron-setup.ts';
packageJson.scripts['runbook:build'] = 'cd scripts/agent-runbook && npm run build';

// Write back
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
console.log('Added runbook scripts to package.json');

// Also update the main scripts directory README or index if exists
console.log('\nAdded scripts:');
console.log('  pnpm runbook:generate    - Generate agent runbook');
console.log('  pnpm runbook:schedule    - Set up automatic scheduling');
console.log('  pnpm runbook:build       - Build TypeScript files');