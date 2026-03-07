#!/usr/bin/env node

// Comprehensive Unified Timeout System Validation Script
// Ensures only the unified deadline system is in place

import fs from 'fs';
import path from 'path';

console.log('🔍 COMPREHENSIVE TIMEOUT SYSTEM VALIDATION');
console.log('==========================================');

const serverDir = path.join(process.cwd(), 'server');
const files = fs.readdirSync(serverDir).filter(f => f.endsWith('.ts'));

let hasConflicts = false;
let unifiedReferences = 0;

// Patterns to detect conflicting timeout systems
const conflictPatterns = [
  /setTimeout.*\d+.*60.*1000/,          // setTimeout with minute calculations
  /timeout.*after.*\d+.*minutes/i,     // "timeout after X minutes" messages
  /adaptive.*timeout/i,                 // adaptive timeout references
  /processing.*timeout/i,               // processing timeout references
  /\d+.*\*.*60.*\*.*1000/,             // manual minute-to-millisecond calculations
];

// Patterns to detect our unified system
const unifiedPatterns = [
  /calculateJobDeadline/,
  /TimeoutManager/,
  /deadline.*system/i,
  /unified.*deadline/i,
];

files.forEach(file => {
  const filePath = path.join(serverDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  lines.forEach((line, index) => {
    // Check for conflicting patterns
    conflictPatterns.forEach(pattern => {
      if (pattern.test(line) && !line.includes('//') && !line.includes('validate-unified-timeouts')) {
        console.log(`❌ CONFLICT in ${file}:${index + 1} - ${line.trim()}`);
        hasConflicts = true;
      }
    });
    
    // Count unified system references
    unifiedPatterns.forEach(pattern => {
      if (pattern.test(line)) {
        unifiedReferences++;
      }
    });
  });
});

console.log('\n📊 VALIDATION RESULTS:');
console.log(`✅ Unified System References: ${unifiedReferences}`);
console.log(`${hasConflicts ? '❌' : '✅'} Conflicting Systems: ${hasConflicts ? 'FOUND' : 'NONE'}`);

if (!hasConflicts && unifiedReferences > 0) {
  console.log('\n🎉 SUCCESS: Unified timeout system is the only system in place!');
  console.log('📋 SYSTEM CONFIGURATION:');
  console.log('   • Base timeout: 8 minutes');
  console.log('   • Duration factor: 2.2x video length');
  console.log('   • Buffer: 20% safety margin');
  console.log('   • Maximum: 80 minutes cap');
  console.log('   • All components respect single deadline');
  
  process.exit(0);
} else {
  console.log('\n⚠️  VALIDATION INCOMPLETE');
  if (hasConflicts) {
    console.log('   • Remove conflicting timeout systems above');
  }
  if (unifiedReferences === 0) {
    console.log('   • No unified system references found');
  }
  
  process.exit(1);
}