import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Allow local overrides so secrets/paths do not need to be hard-coded in source.
export const CONFIG_PATH = process.env.VIO_WRAPPER_CONFIG_PATH || '/Users/visen24/MAS/openclaw_state_fork/openclaw.json';
export const PROJECT_ROOT = process.env.VIO_WRAPPER_PROJECT_ROOT || '/Volumes/2TB/MAS';

// First-wave relocation fields.
export const OPENCLAW_REPO_ROOT = process.env.VIO_OPENCLAW_REPO_ROOT || '/Users/visen24/MAS/openclaw_fork';
export const DASHBOARD_APP_ROOT = process.env.VIO_DASHBOARD_APP_ROOT || path.resolve(__dirname, '..');
export const DASHBOARD_DATA_ROOT = process.env.VIO_DASHBOARD_DATA_ROOT || path.join(DASHBOARD_APP_ROOT, 'data');
export const DASHBOARD_CACHE_ROOT = process.env.VIO_DASHBOARD_CACHE_ROOT || path.join(PROJECT_ROOT, 'runtime-cache', 'viodashboard');
export const TOKEN_SAVER_DEBUG_ROOT = process.env.VIO_TOKEN_SAVER_DEBUG_ROOT || path.join(DASHBOARD_DATA_ROOT, 'token-saver-debug');
export const CLAUDE_RUNTIME_ROOT = process.env.VIO_CLAUDE_RUNTIME_ROOT || path.join(DASHBOARD_DATA_ROOT, 'claude');
export const SAFE_EDIT_ROOT = process.env.VIO_SAFE_EDIT_ROOT || path.join(DASHBOARD_CACHE_ROOT, 'safe-edit');
export const COMS_ROOT = process.env.VIO_COMS_ROOT || path.join(DASHBOARD_APP_ROOT, 'coms');
export const MEMORY_SYSTEM_ROOT = process.env.VIO_MEMORY_SYSTEM_ROOT || path.join(DASHBOARD_APP_ROOT, 'memory_system');
export const DEFAULT_CLAUDE_CWD = process.env.VIO_DEFAULT_CLAUDE_CWD || OPENCLAW_REPO_ROOT;
export const DASHBOARD_LAUNCHD_ROOT = process.env.VIO_DASHBOARD_LAUNCHD_ROOT || path.join(DASHBOARD_APP_ROOT, 'launchd');
export const OPENCLAW_DIST_ROOT = process.env.VIO_OPENCLAW_DIST_ROOT || path.join(OPENCLAW_REPO_ROOT, 'dist');
export const OPENCLAW_DIST_BUILD_INFO = process.env.VIO_OPENCLAW_DIST_BUILD_INFO || path.join(OPENCLAW_DIST_ROOT, 'build-info.json');
export const LEGACY_VIODASHBOARD_ROOT = process.env.VIO_LEGACY_VIODASHBOARD_ROOT || path.join(PROJECT_ROOT, 'legacy', 'VioDashboard');
export const LEGACY_VIODASHBOARD_NODE_MODULES = process.env.VIO_LEGACY_VIODASHBOARD_NODE_MODULES || path.join(LEGACY_VIODASHBOARD_ROOT, 'node_modules');

export const EXTRA_ALLOWED_ROOTS = [
  '/Users/visen24/MAS',
].filter(Boolean);

export const APP_DISPLAY_NAME = process.env.VIO_WRAPPER_APP_DISPLAY_NAME || 'VioDashboard';
export const APP_SERVICE_NAME = process.env.VIO_WRAPPER_APP_SERVICE_NAME || APP_DISPLAY_NAME;
export const APP_SLUG = process.env.VIO_WRAPPER_APP_SLUG || 'viodashboard';
export const APP_DIR_NAME = process.env.VIO_WRAPPER_APP_DIR_NAME || 'VioDashboard';
export const LAUNCHD_LABEL = process.env.VIO_WRAPPER_LAUNCHD_LABEL || 'com.vio.dashboard';
export const LAUNCHD_PLIST_NAME = process.env.VIO_WRAPPER_LAUNCHD_PLIST || 'com.vio.dashboard.plist';
export const RUNTIME_DIR_NAME = process.env.VIO_WRAPPER_RUNTIME_DIR_NAME || 'VioDashboardRuntime';
export const LOG_DIR_NAME = process.env.VIO_WRAPPER_LOG_DIR_NAME || 'VioDashboard';

export const ROOT = DASHBOARD_APP_ROOT;
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = DASHBOARD_DATA_ROOT;
export const DEBUG_DIR = TOKEN_SAVER_DEBUG_ROOT;
export const APP_SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support');
export const APP_SUPPORT_RUNTIME_DIR = path.join(APP_SUPPORT_DIR, RUNTIME_DIR_NAME);
export const APP_LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', LOG_DIR_NAME);
export const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
export const LAUNCHD_PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, LAUNCHD_PLIST_NAME);
export const APP_BASE_URL = process.env.VIO_WRAPPER_BASE || 'http://127.0.0.1:8789';

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
export const wrapperPort = Number(process.env.VIO_WRAPPER_PORT || 8791);

const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
export const gatewayPort = Number(process.env.VIO_WRAPPER_GATEWAY_PORT || config?.gateway?.port || 19001);
export const gatewayToken = process.env.VIO_WRAPPER_GATEWAY_TOKEN || config?.gateway?.auth?.token || '';
export const gatewayUrl = process.env.VIO_WRAPPER_GATEWAY_URL || `ws://127.0.0.1:${gatewayPort}`;
export const OPENCLAW_BIN = process.env.VIO_WRAPPER_OPENCLAW_BIN || 'openclaw';
export const GATEWAY_PROFILE = process.env.VIO_WRAPPER_GATEWAY_PROFILE || 'mas-fork';
export const PNPM_BIN = process.env.VIO_WRAPPER_PNPM_BIN || '/opt/homebrew/bin/pnpm';

export const ROADMAP_DATA_PATH = path.join(DASHBOARD_DATA_ROOT, 'roadmap.json');
export const ROADMAP_HISTORY_DATA_PATH = path.join(DASHBOARD_DATA_ROOT, 'roadmap-history.json');
