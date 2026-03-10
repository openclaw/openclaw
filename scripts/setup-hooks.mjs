// scripts/setup-hooks.mjs
import { execSync } from 'node:child_process';

try {
  execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  execSync('git config core.hooksPath git-hooks', { stdio: 'ignore' });
  console.log('✅ Git hooks configured successfully.');
} catch (error) {
  // 听取 Greptile 的建议：给开发者留下一条友好的警告线索
  console.warn('⚠️ Note: Git hooks were not configured (expected if you downloaded a ZIP or are not in a git repository).');
  console.warn(`   Details: ${error.message}`);
  
  // 依然以状态码 0 退出，绝对不阻断 pnpm install 的主流程
  process.exit(0);
}