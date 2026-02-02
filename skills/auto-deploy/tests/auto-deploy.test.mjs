#!/usr/bin/env node

/**
 * Unit Tests for Auto-Deployment Skill
 */

import { detectEnvironment, checkNodeVersion, checkGit } from '../lib/detector.js';
import { runDiagnostics } from '../lib/troubleshooter.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   ${error.message}`);
    testsFailed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

async function runTests() {
  // Test Suite: Environment Detection
  console.log('\n═════════════════════════════════════════');
  console.log('Test Suite: Environment Detection');
  console.log('═════════════════════════════════════════\n');

  test('detectEnvironment returns object', () => {
    const env = detectEnvironment();
    assert(typeof env === 'object', 'Should return object');
    assert(env.os !== undefined, 'Should have os property');
    assert(env.node !== undefined, 'Should have node property');
  });

  test('detectEnvironment detects OS', () => {
    const env = detectEnvironment();
    assert(env.os.id, 'Should detect OS ID');
    assert(env.os.prettyName, 'Should have pretty OS name');
  });

  test('checkNodeVersion returns version', () => {
    const node = checkNodeVersion();
    assert(typeof node.installed === 'boolean', 'Should have installed flag');
    if (node.installed) {
      assert(node.version, 'Should have version string');
      assert(typeof node.major === 'number', 'Should have major version number');
    }
  });

  test('checkGit returns status', () => {
    const git = checkGit();
    assert(typeof git.installed === 'boolean', 'Should have installed flag');
  });

  // Test Suite: Troubleshooting
  console.log('\n═════════════════════════════════════════');
  console.log('Test Suite: Troubleshooting');
  console.log('═════════════════════════════════════════\n');

  test('runDiagnostics completes without error', async () => {
    const results = await runDiagnostics();
    assert(results === true || typeof results === 'object', 'Should return results');
  });

  // Test Suite: File System
  console.log('\n═════════════════════════════════════════');
  console.log('Test Suite: File System');
  console.log('═════════════════════════════════════════\n');

  test('Skill directory exists', () => {
    const skillDir = path.join(__dirname, '..');
    assert(fs.existsSync(skillDir), 'Skill directory should exist');
  });

  test('All required modules exist', () => {
    const libDir = path.join(__dirname, '..', 'lib');
    
    const requiredFiles = [
      'detector.js',
      'installer.js',
      'configurator.js',
      'validator.js',
      'troubleshooter.js'
    ];
    
    requiredFiles.forEach(file => {
      const filePath = path.join(libDir, file);
      assert(fs.existsSync(filePath), `Module ${file} should exist`);
    });
  });

  test('Documentation files exist', () => {
    const skillDir = path.join(__dirname, '..');
    
    assert(fs.existsSync(path.join(skillDir, 'SKILL.md')), 'SKILL.md should exist');
    assert(fs.existsSync(path.join(skillDir, 'README.md')), 'README.md should exist');
  });

  // Summary
  console.log('\n═════════════════════════════════════════');
  console.log('Test Summary');
  console.log('═════════════════════════════════════════');
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);
  console.log(`Total:  ${testsPassed + testsFailed}`);
  console.log('═════════════════════════════════════════\n');

  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests();
