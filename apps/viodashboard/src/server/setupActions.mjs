// Controlled action layer for the VioDashboard setup wizard (phase 4A).
//
// Exposes a small, explicit set of low-risk actions via POST /api/setup/action.
// The route handler in server.mjs is responsible for the HTTP response and any
// post-send scheduling (for example wrapper-reload).
//
// Safety boundary: no hidden writes, no automatic local config generation,
// no broad install actions. Only the three actions below are accepted.

import path from 'node:path';
import { execFile } from 'node:child_process';

import { DASHBOARD_APP_ROOT } from '../config.mjs';
import { evaluateSetupState } from './setupState.mjs';

// Explicit allowlist — unknown action IDs are rejected at the dispatcher.
const ALLOWED_ACTIONS = new Set(['setup-refresh', 'bootstrap-preview', 'wrapper-reload']);

// ---------------------------------------------------------------------------
// setup-refresh
// Re-evaluates setup state and returns it. Pure read, no side effects.
// ---------------------------------------------------------------------------

function handleSetupRefresh({ bridgeConnected, claudeState }) {
  const state = evaluateSetupState({ bridgeConnected, claudeState });
  return { ok: true, action: 'setup-refresh', state };
}

// ---------------------------------------------------------------------------
// bootstrap-preview
// Dry-run the bootstrap script and return its printed output.
// Uses --print --yes to suppress interactive prompts.
// ---------------------------------------------------------------------------

function handleBootstrapPreview() {
  const scriptPath = path.join(DASHBOARD_APP_ROOT, 'scripts', 'bootstrap-local-config.mjs');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath, '--print', '--yes'],
      { cwd: DASHBOARD_APP_ROOT, timeout: 15000, env: process.env },
      (error, stdout, stderr) => {
        // A non-zero exit with no stdout is a genuine failure.
        if (error && !stdout) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        const output = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        resolve({
          ok: true,
          action: 'bootstrap-preview',
          output,
          stderr: stderr?.trim() || null,
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// wrapper-reload
// Schedules a launchd reload of the wrapper service after the response is sent.
// The internal _reload flag tells the route handler to schedule execFile.
// ---------------------------------------------------------------------------

function handleWrapperReload() {
  return {
    ok: true,
    action: 'wrapper-reload',
    message: 'Dashboard service restart initiated. The service will restart in a moment.',
    _reload: true,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a setup wizard action.
 *
 * @param {{ action: string, bridgeConnected: boolean, claudeState: object }} opts
 * @returns {Promise<object>} Structured action result.
 *   wrapper-reload results include an internal `_reload: true` flag that the
 *   route handler uses to schedule the execFile call after sending the response.
 */
export async function handleSetupAction({ action, bridgeConnected, claudeState }) {
  if (!ALLOWED_ACTIONS.has(action)) {
    const allowed = [...ALLOWED_ACTIONS].join(', ');
    throw new Error(`Unknown action "${action}". Allowed: ${allowed}`);
  }

  if (action === 'setup-refresh') { return handleSetupRefresh({ bridgeConnected, claudeState }); }
  if (action === 'bootstrap-preview') { return handleBootstrapPreview(); }
  if (action === 'wrapper-reload') { return handleWrapperReload(); }
}
