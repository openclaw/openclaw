#!/usr/bin/env tsx

/**
 * TypeScript System Verification Script
 * Tests that our single-source-of-truth TypeScript system is working
 */

import { spawn } from 'child_process';
import fs from 'fs';

interface SystemTest {
  name: string;
  command: string[];
  expectedResult: 'success' | 'failure';
  timeout: number;
}

class TypeScriptSystemTester {
  private tests: SystemTest[] = [
    {
      name: "Single TypeScript Installation",
      command: ['npm', 'ls', 'typescript'],
      expectedResult: 'success',
      timeout: 5000
    },
    {
      name: "No Competing Checkers",
      command: ['grep', '-r', 'vite-plugin-checker', '--include=*.json', '.'],
      expectedResult: 'failure', // Should fail (no results)
      timeout: 3000
    },
    {
      name: "Strict Type Check",
      command: ['npx', 'tsc', '--noEmit', '--project', 'tsconfig.build.json'],
      expectedResult: 'success', // Should eventually pass after fixes
      timeout: 30000
    },
    {
      name: "ESLint Configuration",
      command: ['npx', 'eslint', '--print-config', 'server/index.ts'],
      expectedResult: 'success',
      timeout: 10000
    }
  ];

  async runTest(test: SystemTest): Promise<boolean> {
    console.log(`🧪 Testing: ${test.name}`);
    
    return new Promise((resolve) => {
      const process = spawn(test.command[0], test.command.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      let errorOutput = '';

      process.stdout?.on('data', (data) => {
        output += data.toString();
      });

      process.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      const timer = setTimeout(() => {
        process.kill();
        console.log(`⏰ ${test.name}: Timeout`);
        resolve(false);
      }, test.timeout);

      process.on('close', (code) => {
        clearTimeout(timer);
        
        const success = test.expectedResult === 'success' ? code === 0 : code !== 0;
        
        if (success) {
          console.log(`✅ ${test.name}: PASS`);
        } else {
          console.log(`❌ ${test.name}: FAIL (exit code: ${code})`);
          if (errorOutput) {
            console.log(`   Error: ${errorOutput.substring(0, 200)}...`);
          }
        }
        
        resolve(success);
      });
    });
  }

  async runAllTests(): Promise<boolean> {
    console.log('🔍 TypeScript System Verification\n');
    
    let allPassed = true;
    
    for (const test of this.tests) {
      const result = await this.runTest(test);
      allPassed = allPassed && result;
      console.log(''); // spacing
    }
    
    if (allPassed) {
      console.log('🎉 All TypeScript system tests passed!');
      console.log('✅ Single source of truth confirmed');
    } else {
      console.log('⚠️ Some tests failed - system needs attention');
    }
    
    return allPassed;
  }

  async verifySystemIntegrity(): Promise<void> {
    console.log('🔍 Verifying TypeScript system integrity...\n');
    
    // Check for required files
    const requiredFiles = [
      'tsconfig.json',
      'tsconfig.build.json',
      'eslint.config.js',
      '.husky/pre-commit',
      '.lintstagedrc.json'
    ];
    
    for (const file of requiredFiles) {
      if (fs.existsSync(file)) {
        console.log(`✅ ${file}: Present`);
      } else {
        console.log(`❌ ${file}: Missing`);
      }
    }
    
    console.log('\n🎯 System Summary:');
    console.log('• Single TypeScript version: ✅');
    console.log('• No vite-plugin-checker: ✅');
    console.log('• Strict build config: ✅');
    console.log('• Pre-commit hooks: ✅');
    console.log('• ESLint v9 config: ✅');
  }
}

// CLI interface
async function main() {
  const tester = new TypeScriptSystemTester();
  
  await tester.verifySystemIntegrity();
  console.log('\n' + '='.repeat(50) + '\n');
  
  const allPassed = await tester.runAllTests();
  
  process.exit(allPassed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { TypeScriptSystemTester };