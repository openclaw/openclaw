#!/usr/bin/env node

/**
 * Hvigor Wrapper Script
 * This script invokes the Hvigor build tool for HarmonyOS projects
 */

const { execSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const HVIGOR_VERSION = '5.0.0';
const NODE_MODULES_PATH = join(__dirname, 'node_modules');
const HVIGOR_PATH = join(NODE_MODULES_PATH, '@ohos', 'hvigor');

// Check if hvigor is installed
if (!existsSync(HVIGOR_PATH)) {
  console.log('Hvigor not found. Installing dependencies...');
  try {
    execSync('npm install', { stdio: 'inherit', cwd: __dirname });
  } catch (error) {
    console.error('Failed to install dependencies:', error.message);
    process.exit(1);
  }
}

// Run hvigor with passed arguments
const args = process.argv.slice(2).join(' ');
const command = `hvigor ${args}`;

try {
  execSync(command, {
    stdio: 'inherit',
    cwd: __dirname,
    env: {
      ...process.env,
      HVIGOR_VERSION: HVIGOR_VERSION
    }
  });
} catch (error) {
  console.error('Build failed:', error.message);
  process.exit(1);
}
