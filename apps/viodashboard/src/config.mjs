import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import defaultConfig from '../config/default.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localConfigPath = path.resolve(__dirname, '..', 'config', 'local.mjs');

async function loadLocalConfig() {
  if (!fs.existsSync(localConfigPath)) {return {};}
  try {
    const mod = await import(pathToFileURL(localConfigPath).href);
    const value = mod?.default;
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    console.warn('[viodashboard] failed to load config/local.mjs:', error?.message || String(error));
    return {};
  }
}

const localConfig = await loadLocalConfig();

function envOr(name, fallback) {
  return process.env[name] || fallback;
}

function arrayValue(value, fallback = []) {
  if (Array.isArray(value)) {return value.filter(Boolean).map(String);}
  return fallback;
}

const mergedConfig = {
  ...defaultConfig,
  ...localConfig,
};

export const CONFIG_PATH = envOr('VIO_WRAPPER_CONFIG_PATH', mergedConfig.configPath);
export const PROJECT_ROOT = envOr('VIO_WRAPPER_PROJECT_ROOT', mergedConfig.workspaceRoot);
export const OPENCLAW_REPO_ROOT = envOr('VIO_OPENCLAW_REPO_ROOT', mergedConfig.openclawRepoRoot);
export const DASHBOARD_APP_ROOT = envOr('VIO_DASHBOARD_APP_ROOT', mergedConfig.dashboardAppRoot);
export const DASHBOARD_DATA_ROOT = envOr('VIO_DASHBOARD_DATA_ROOT', mergedConfig.dashboardDataRoot || path.join(DASHBOARD_APP_ROOT, 'data'));
export const DASHBOARD_CACHE_ROOT = envOr('VIO_DASHBOARD_CACHE_ROOT', mergedConfig.dashboardCacheRoot || path.join(PROJECT_ROOT, 'runtime-cache', 'viodashboard'));
export const TOKEN_SAVER_DEBUG_ROOT = envOr('VIO_TOKEN_SAVER_DEBUG_ROOT', mergedConfig.tokenSaverDebugRoot || path.join(DASHBOARD_DATA_ROOT, 'token-saver-debug'));
export const CLAUDE_RUNTIME_ROOT = envOr('VIO_CLAUDE_RUNTIME_ROOT', mergedConfig.claudeRuntimeRoot || path.join(DASHBOARD_CACHE_ROOT, 'claude'));
export const SAFE_EDIT_ROOT = envOr('VIO_SAFE_EDIT_ROOT', mergedConfig.safeEditRoot || path.join(DASHBOARD_CACHE_ROOT, 'safe-edit'));
export const COMS_ROOT = envOr('VIO_COMS_ROOT', mergedConfig.comsRoot || path.join(DASHBOARD_APP_ROOT, 'coms'));
export const MEMORY_SYSTEM_ROOT = envOr('VIO_MEMORY_SYSTEM_ROOT', mergedConfig.memorySystemRoot || path.join(DASHBOARD_APP_ROOT, 'memory_system'));
export const DEFAULT_CLAUDE_CWD = envOr('VIO_DEFAULT_CLAUDE_CWD', mergedConfig.defaultClaudeCwd || OPENCLAW_REPO_ROOT);
export const DASHBOARD_LAUNCHD_ROOT = envOr('VIO_DASHBOARD_LAUNCHD_ROOT', mergedConfig.dashboardLaunchdRoot || path.join(DASHBOARD_APP_ROOT, 'launchd'));
export const OPENCLAW_DIST_ROOT = envOr('VIO_OPENCLAW_DIST_ROOT', mergedConfig.openclawDistRoot || path.join(OPENCLAW_REPO_ROOT, 'dist'));
export const OPENCLAW_DIST_BUILD_INFO = envOr('VIO_OPENCLAW_DIST_BUILD_INFO', mergedConfig.openclawDistBuildInfo || path.join(OPENCLAW_DIST_ROOT, 'build-info.json'));
export const LEGACY_VIODASHBOARD_ROOT = envOr('VIO_LEGACY_VIODASHBOARD_ROOT', mergedConfig.legacyViodashboardRoot || path.join(PROJECT_ROOT, 'legacy', 'VioDashboard'));
export const LEGACY_VIODASHBOARD_NODE_MODULES = envOr('VIO_LEGACY_VIODASHBOARD_NODE_MODULES', mergedConfig.legacyViodashboardNodeModules || path.join(LEGACY_VIODASHBOARD_ROOT, 'node_modules'));
export const EXTRA_ALLOWED_ROOTS = arrayValue(mergedConfig.extraAllowedRoots, [PROJECT_ROOT]);

export const APP_DISPLAY_NAME = envOr('VIO_WRAPPER_APP_DISPLAY_NAME', mergedConfig.appDisplayName || 'VioDashboard');
export const APP_SERVICE_NAME = envOr('VIO_WRAPPER_APP_SERVICE_NAME', mergedConfig.appServiceName || APP_DISPLAY_NAME);
export const APP_SLUG = envOr('VIO_WRAPPER_APP_SLUG', mergedConfig.appSlug || 'viodashboard');
export const APP_DIR_NAME = envOr('VIO_WRAPPER_APP_DIR_NAME', mergedConfig.appDirName || 'VioDashboard');
export const LAUNCHD_LABEL = envOr('VIO_WRAPPER_LAUNCHD_LABEL', mergedConfig.launchdLabel || 'com.vio.dashboard');
export const LAUNCHD_PLIST_NAME = envOr('VIO_WRAPPER_LAUNCHD_PLIST', mergedConfig.launchdPlistName || 'com.vio.dashboard.plist');
export const RUNTIME_DIR_NAME = envOr('VIO_WRAPPER_RUNTIME_DIR_NAME', mergedConfig.runtimeDirName || 'VioDashboardRuntime');
export const LOG_DIR_NAME = envOr('VIO_WRAPPER_LOG_DIR_NAME', mergedConfig.logDirName || 'VioDashboard');

export const ROOT = DASHBOARD_APP_ROOT;
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = DASHBOARD_DATA_ROOT;
export const DEBUG_DIR = TOKEN_SAVER_DEBUG_ROOT;
export const APP_SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support');
export const APP_SUPPORT_RUNTIME_DIR = path.join(APP_SUPPORT_DIR, RUNTIME_DIR_NAME);
export const APP_LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', LOG_DIR_NAME);
export const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
export const LAUNCHD_PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, LAUNCHD_PLIST_NAME);
export const APP_BASE_URL = envOr('VIO_WRAPPER_BASE', mergedConfig.appBaseUrl || 'http://127.0.0.1:8791');

export const AREAS_DIR = path.join(PROJECT_ROOT, 'areas');
export const VIO_CAM_REAL_DIR = path.join(AREAS_DIR, 'utilities', 'vio_cam');
export const GESTURE_V1_REAL_DIR = path.join(AREAS_DIR, 'research', 'Research', 'Vision', 'gesture_v1');

export function appRel(...parts) {
  return path.posix.join(APP_DIR_NAME, ...parts.map(part => String(part).replace(/\\/g, '/')));
}

export function appPath(...parts) {
  return path.join(DASHBOARD_APP_ROOT, ...parts);
}

export const CAMERA_PROVIDERS = {
  eos: {
    id: 'eos',
    label: 'Canon EOS Webcam Utility',
    dir: VIO_CAM_REAL_DIR,
    captureScript: path.join(VIO_CAM_REAL_DIR, 'capture-warmup.sh'),
  },
};

export const ACTIVE_CAMERA_PROVIDER = CAMERA_PROVIDERS.eos;
export const VIO_CAM_DIR = ACTIVE_CAMERA_PROVIDER.dir;
export const VIO_CAM_CAPTURE_SCRIPT = ACTIVE_CAMERA_PROVIDER.captureScript;
export const GESTURE_STATE_PATH = path.join(GESTURE_V1_REAL_DIR, 'state.json');
export const GESTURE_WORKER_SCRIPT = path.join(GESTURE_V1_REAL_DIR, 'run-worker.sh');
export const GESTURE_RUN_ONCE_SCRIPT = path.join(GESTURE_V1_REAL_DIR, 'run-once.sh');

export const MAX_JSON_BODY_BYTES = 256 * 1024;
export const EDITABLE_TEXT_FILE_RE = /\.(md|txt|json|js|mjs|cjs|ts|tsx|jsx|py|sh|css|html)$/i;
export const wrapperPort = Number(process.env.VIO_WRAPPER_PORT || mergedConfig.wrapperPort || 8791);

const gatewayConfig = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
export const gatewayPort = Number(process.env.VIO_WRAPPER_GATEWAY_PORT || gatewayConfig?.gateway?.port || 19001);
export const gatewayToken = process.env.VIO_WRAPPER_GATEWAY_TOKEN || gatewayConfig?.gateway?.auth?.token || '';
export const gatewayUrl = process.env.VIO_WRAPPER_GATEWAY_URL || `ws://127.0.0.1:${gatewayPort}`;
export const OPENCLAW_BIN = envOr('VIO_WRAPPER_OPENCLAW_BIN', mergedConfig.openclawBin || 'openclaw');
export const GATEWAY_PROFILE = envOr('VIO_WRAPPER_GATEWAY_PROFILE', mergedConfig.gatewayProfile || 'mas-fork');
export const PNPM_BIN = envOr('VIO_WRAPPER_PNPM_BIN', mergedConfig.pnpmBin || 'pnpm');
export const CLAUDE_BIN = envOr('CLAUDE_CLI_PATH', mergedConfig.claudeBin || 'claude');

export const ROADMAP_DATA_PATH = path.join(DASHBOARD_DATA_ROOT, 'roadmap.json');
export const ROADMAP_HISTORY_DATA_PATH = path.join(DASHBOARD_DATA_ROOT, 'roadmap-history.json');

export const CLIENT_CONFIG = {
  defaultClaudeCwd: DEFAULT_CLAUDE_CWD,
  projectRoot: PROJECT_ROOT,
  openclawRepoRoot: OPENCLAW_REPO_ROOT,
  appBaseUrl: APP_BASE_URL,
};
