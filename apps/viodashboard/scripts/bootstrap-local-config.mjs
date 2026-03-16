#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(APP_ROOT, 'config');
const LOCAL_CONFIG_PATH = path.join(CONFIG_DIR, 'local.mjs');
const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, 'default.mjs');

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const yes = args.has('--yes') || args.has('-y');
const printOnly = args.has('--print');

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function normalizePathValue(value) {
  return path.resolve(String(value || '').trim());
}

function shellQuote(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

async function loadDefaultConfig() {
  const mod = await import(pathToFileUrl(DEFAULT_CONFIG_PATH));
  return mod.default || {};
}

function pathToFileUrl(filePath) {
  const url = new URL('file://');
  url.pathname = path.resolve(filePath).split(path.sep).join('/');
  if (!url.pathname.startsWith('/')) {url.pathname = `/${url.pathname}`;}
  return url.href;
}

function detectClaudeBin() {
  const home = os.homedir();
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (exists(candidate)) {return candidate;}
  }
  return 'claude';
}

function detectConfigPath() {
  const home = os.homedir();
  const candidates = [
    process.env.OPENCLAW_CONFIG_PATH,
    path.join(home, '.openclaw-assistant-ui', 'openclaw.json'),
    path.join(home, '.openclaw', 'openclaw.json'),
    path.join(APP_ROOT, '..', '..', '..', 'openclaw_state_fork', 'openclaw.json'),
  ].filter(Boolean).map(candidate => path.resolve(candidate));
  for (const candidate of candidates) {
    if (exists(candidate)) {return candidate;}
  }
  return candidates[0] || path.join(home, '.openclaw-assistant-ui', 'openclaw.json');
}

function buildInitialValues(defaultConfig) {
  const openclawRepoRoot = normalizePathValue(defaultConfig.openclawRepoRoot || path.resolve(APP_ROOT, '..', '..'));
  const workspaceRoot = normalizePathValue(defaultConfig.workspaceRoot || path.resolve(openclawRepoRoot, '..'));
  return {
    openclawRepoRoot,
    workspaceRoot,
    configPath: detectConfigPath(),
    defaultClaudeCwd: openclawRepoRoot,
    claudeBin: detectClaudeBin(),
    extraAllowedRoots: [workspaceRoot],
  };
}

function renderConfig(values) {
  return `export default {\n  openclawRepoRoot: '${shellQuote(values.openclawRepoRoot)}',\n  workspaceRoot: '${shellQuote(values.workspaceRoot)}',\n  configPath: '${shellQuote(values.configPath)}',\n  defaultClaudeCwd: '${shellQuote(values.defaultClaudeCwd)}',\n  claudeBin: '${shellQuote(values.claudeBin)}',\n  extraAllowedRoots: [\n    '${shellQuote(values.extraAllowedRoots[0])}',\n  ],\n};\n`;
}

async function promptValue(rl, label, currentValue) {
  const answer = await rl.question(`${label}\n[${currentValue}] > `);
  return answer.trim() ? answer.trim() : currentValue;
}

async function main() {
  if (!printOnly && exists(LOCAL_CONFIG_PATH) && !force) {
    console.error(`[viodashboard bootstrap] local config already exists: ${LOCAL_CONFIG_PATH}`);
    console.error('Use --force to overwrite it, or edit it manually.');
    process.exit(1);
  }

  const defaultConfig = await loadDefaultConfig();
  const values = buildInitialValues(defaultConfig);

  console.log('VioDashboard local config bootstrap');
  console.log(`App root: ${APP_ROOT}`);
  console.log(`Output: ${LOCAL_CONFIG_PATH}`);
  console.log('This writes a gitignored machine-local config only.\n');

  if (!yes) {
    const rl = readline.createInterface({ input, output });
    try {
      values.openclawRepoRoot = normalizePathValue(await promptValue(rl, 'OpenClaw repo root', values.openclawRepoRoot));
      values.workspaceRoot = normalizePathValue(await promptValue(rl, 'Workspace root', values.workspaceRoot));
      values.configPath = normalizePathValue(await promptValue(rl, 'OpenClaw config path', values.configPath));
      values.defaultClaudeCwd = normalizePathValue(await promptValue(rl, 'Default Claude cwd', values.defaultClaudeCwd));
      values.claudeBin = await promptValue(rl, 'Claude CLI path (absolute path recommended for launchd)', values.claudeBin);
      const extraRoot = normalizePathValue(await promptValue(rl, 'Extra allowed root', values.workspaceRoot));
      values.extraAllowedRoots = [extraRoot];

      console.log('\nPreview:\n');
      const preview = renderConfig(values);
      console.log(preview);
      const confirm = await rl.question(printOnly ? 'Print-only mode; press Enter to finish.' : 'Write this file? [y/N] ');
      if (!printOnly && !/^y(es)?$/i.test(confirm.trim())) {
        console.log('Aborted.');
        process.exit(0);
      }
    } finally {
      rl.close();
    }
  }

  const content = renderConfig(values);
  if (printOnly) {
    process.stdout.write(content);
    return;
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(LOCAL_CONFIG_PATH, content, 'utf8');
  console.log(`[viodashboard bootstrap] wrote ${LOCAL_CONFIG_PATH}`);
}

main().catch(error => {
  console.error(`[viodashboard bootstrap] failed: ${error?.stack || error}`);
  process.exit(1);
});
