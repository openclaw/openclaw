#!/usr/bin/env node
'use strict';

/**
 * Setup script for OpenClaw RAG.
 *
 * Creates ~/.openclaw/rag/config.json from the default template,
 * resolving paths for the current user. Safe to re-run — won't
 * overwrite an existing config.
 *
 * Usage: node setup.js [--force]
 */

const path = require('path');
const fs = require('fs');

const home = process.env.HOME || process.env.USERPROFILE;
const ragDir = path.join(home, '.openclaw', 'rag');
const configPath = path.join(ragDir, 'config.json');
const logsDir = path.join(home, '.openclaw', 'logs');

function main() {
  const force = process.argv.includes('--force');

  if (fs.existsSync(configPath) && !force) {
    console.log(`Config already exists at ${configPath}`);
    console.log('Use --force to overwrite.');
    return;
  }

  // Load default config
  const defaults = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')
  );

  // Resolve paths for this user
  const config = {
    ...defaults,
    workspaceRoot: path.join(home, '.openclaw', 'workspace'),
    dbPath: path.join(ragDir, 'index.sqlite'),
    logPath: path.join(logsDir, 'rag.log'),
  };

  // Ensure directories exist
  fs.mkdirSync(ragDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`Created config at ${configPath}`);
  console.log('\nNext steps:');
  console.log('  1. npm install        # install dependencies');
  console.log('  2. npm run index      # build the initial index');
  console.log('  3. npm run query "test query"   # test a search');
  console.log('\nSee README.md for proxy integration instructions.');
}

main();
