import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');

export default {
  appDisplayName: 'VioDashboard',
  appServiceName: 'VioDashboard',
  appSlug: 'viodashboard',
  appDirName: 'VioDashboard',
  launchdLabel: 'com.vio.dashboard',
  launchdPlistName: 'com.vio.dashboard.plist',
  runtimeDirName: 'VioDashboardRuntime',
  logDirName: 'VioDashboard',
  wrapperPort: 8791,
  gatewayProfile: 'mas-fork',
  openclawBin: 'openclaw',
  pnpmBin: '/opt/homebrew/bin/pnpm',
  dashboardAppRoot: APP_ROOT,
  openclawRepoRoot: REPO_ROOT,
  workspaceRoot: WORKSPACE_ROOT,
  dashboardDataRoot: path.join(APP_ROOT, 'data'),
  dashboardCacheRoot: path.join(WORKSPACE_ROOT, 'runtime-cache', 'viodashboard'),
  tokenSaverDebugRoot: path.join(APP_ROOT, 'data', 'token-saver-debug'),
  claudeRuntimeRoot: path.join(WORKSPACE_ROOT, 'runtime-cache', 'viodashboard', 'claude'),
  safeEditRoot: path.join(WORKSPACE_ROOT, 'runtime-cache', 'viodashboard', 'safe-edit'),
  comsRoot: path.join(APP_ROOT, 'coms'),
  memorySystemRoot: path.join(APP_ROOT, 'memory_system'),
  defaultClaudeCwd: REPO_ROOT,
  dashboardLaunchdRoot: path.join(APP_ROOT, 'launchd'),
  openclawDistRoot: path.join(REPO_ROOT, 'dist'),
  openclawDistBuildInfo: path.join(REPO_ROOT, 'dist', 'build-info.json'),
  legacyViodashboardRoot: path.join(WORKSPACE_ROOT, 'legacy', 'VioDashboard'),
  legacyViodashboardNodeModules: path.join(WORKSPACE_ROOT, 'legacy', 'VioDashboard', 'node_modules'),
  configPath: path.join(os.homedir(), '.openclaw-assistant-ui', 'openclaw.json'),
  extraAllowedRoots: [WORKSPACE_ROOT],
  appBaseUrl: 'http://127.0.0.1:8791',
  claudeBin: 'claude',
};
