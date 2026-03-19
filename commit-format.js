import {execSync} from 'child_process';
const path = 'd:/Agent/openclaw';
try {
  execSync('git add -A && git commit -m "style: fix oxfmt formatting issues"', {cwd: path, stdio: 'inherit'});
  execSync('git push origin feature/tree-model-selector', {cwd: path, stdio: 'inherit'});
} catch (e) {
  console.error('Failed');
  process.exit(1);
}
