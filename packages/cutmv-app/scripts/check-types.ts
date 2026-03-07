#!/usr/bin/env tsx

/**
 * Real-time TypeScript checking script for CUTMV
 * Runs continuous type checking with detailed error reporting
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

interface TypeCheckResult {
  hasErrors: boolean;
  errorCount: number;
  warningCount: number;
  errors: string[];
}

class TypeChecker {
  private watchMode: boolean;
  private strictMode: boolean;

  constructor(watchMode = false, strictMode = false) {
    this.watchMode = watchMode;
    this.strictMode = strictMode;
  }

  async runTypeCheck(): Promise<TypeCheckResult> {
    const configFile = this.strictMode ? 'tsconfig.build.json' : 'tsconfig.json';
    const args = ['--noEmit', '--project', configFile];
    
    if (this.watchMode) {
      args.push('--watch');
    }

    console.log(`🔍 Running TypeScript check with ${configFile}...`);

    return new Promise((resolve) => {
      const tsc = spawn('npx', ['tsc', ...args], {
        stdio: ['inherit', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';

      tsc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      tsc.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      tsc.on('close', (code) => {
        const allOutput = output + errorOutput;
        const errors = this.parseErrors(allOutput);
        
        const result: TypeCheckResult = {
          hasErrors: code !== 0,
          errorCount: errors.filter(e => e.includes('error TS')).length,
          warningCount: errors.filter(e => e.includes('warning TS')).length,
          errors: errors
        };

        this.logResults(result);
        resolve(result);
      });

      if (this.watchMode) {
        console.log('👀 Watching for file changes...');
        console.log('Press Ctrl+C to stop watching');
      }
    });
  }

  private parseErrors(output: string): string[] {
    return output
      .split('\n')
      .filter(line => line.includes('error TS') || line.includes('warning TS'))
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  private logResults(result: TypeCheckResult): void {
    if (!result.hasErrors) {
      console.log('✅ No TypeScript errors found!');
      return;
    }

    console.log(`❌ Found ${result.errorCount} errors and ${result.warningCount} warnings:`);
    result.errors.forEach(error => {
      console.log(`  ${error}`);
    });
  }

  async checkUnusedExports(): Promise<void> {
    console.log('🔍 Checking for unused exports...');
    
    const unusedExports = spawn('npx', ['ts-unused-exports', 'tsconfig.json', '--excludePathsFromReport=node_modules'], {
      stdio: 'inherit'
    });

    return new Promise((resolve) => {
      unusedExports.on('close', (code) => {
        if (code === 0) {
          console.log('✅ No unused exports found!');
        } else {
          console.log('⚠️ Found unused exports - consider cleaning up');
        }
        resolve();
      });
    });
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const watchMode = args.includes('--watch') || args.includes('-w');
  const strictMode = args.includes('--strict') || args.includes('-s');
  const checkUnused = args.includes('--unused') || args.includes('-u');

  const checker = new TypeChecker(watchMode, strictMode);

  if (checkUnused) {
    await checker.checkUnusedExports();
    return;
  }

  const result = await checker.runTypeCheck();
  
  if (result.hasErrors && !watchMode) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { TypeChecker };