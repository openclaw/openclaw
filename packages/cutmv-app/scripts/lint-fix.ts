#!/usr/bin/env tsx

/**
 * Automated linting and formatting script for CUTMV
 * Fixes common TypeScript and style issues automatically
 */

import { spawn } from 'child_process';

class LintFixer {
  async runEslintFix(): Promise<boolean> {
    console.log('🧹 Running ESLint with auto-fix...');
    
    return new Promise((resolve) => {
      const eslint = spawn('npx', ['eslint', '.', '--ext', '.ts,.tsx', '--fix'], {
        stdio: 'inherit'
      });

      eslint.on('close', (code) => {
        if (code === 0) {
          console.log('✅ ESLint auto-fix completed successfully!');
          resolve(true);
        } else {
          console.log('⚠️ ESLint found issues that need manual attention');
          resolve(false);
        }
      });
    });
  }

  async runPrettierFix(): Promise<boolean> {
    console.log('💅 Running Prettier formatting...');
    
    return new Promise((resolve) => {
      const prettier = spawn('npx', ['prettier', '--write', '.'], {
        stdio: 'inherit'
      });

      prettier.on('close', (code) => {
        if (code === 0) {
          console.log('✅ Prettier formatting completed!');
          resolve(true);
        } else {
          console.log('❌ Prettier formatting failed');
          resolve(false);
        }
      });
    });
  }

  async runFullFix(): Promise<boolean> {
    console.log('🔧 Running complete lint and format fix...');
    
    const prettierSuccess = await this.runPrettierFix();
    const eslintSuccess = await this.runEslintFix();
    
    if (prettierSuccess && eslintSuccess) {
      console.log('✅ All fixes completed successfully!');
      return true;
    } else {
      console.log('⚠️ Some issues may require manual attention');
      return false;
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const lintOnly = args.includes('--lint-only');
  const formatOnly = args.includes('--format-only');

  const fixer = new LintFixer();

  if (lintOnly) {
    const success = await fixer.runEslintFix();
    process.exit(success ? 0 : 1);
  } else if (formatOnly) {
    const success = await fixer.runPrettierFix();
    process.exit(success ? 0 : 1);
  } else {
    const success = await fixer.runFullFix();
    process.exit(success ? 0 : 1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { LintFixer };