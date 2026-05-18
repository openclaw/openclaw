import { defineConfig } from 'tsdown';
console.error('CONFIG_CWD', process.cwd());
export default defineConfig([{ entry: { test: 'src/index.ts' }, clean: true }]);
