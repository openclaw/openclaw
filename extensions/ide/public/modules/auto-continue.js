// ============================================
// AUTO-CONTINUE MODULE - Resume on Context Limit
// ============================================
// Automatically continues agent work if context limit is hit

const autoContinueState = {
  enabled: true,
  maxRetries: 3,
  currentRetries: 0,
  lastContinueTime: 0,
  minContinueInterval: 5000, // 5 seconds minimum between continues
  pendingContinue: null,
};

/**
 * Initialize auto-continue module
 */
function initAutoContinue() {
  // Load settings
  const saved = localStorage.getItem('autoContinueEnabled');
  if (saved !== null) {
    autoContinueState.enabled = saved === 'true';
  }
  
  console.log('🔄 Auto-continue initialized, enabled:', autoContinueState.enabled);
}

/**
 * Toggle auto-continue
 * @param {boolean} enabled - Enable or disable
 */
function toggleAutoContinue(enabled = null) {
  if (enabled === null) {
    autoContinueState.enabled = !autoContinueState.enabled;
  } else {
    autoContinueState.enabled = enabled;
  }
  
  localStorage.setItem('autoContinueEnabled', autoContinueState.enabled.toString());
  
  showNotification(
    autoContinueState.enabled ? '🔄 Auto-continue enabled' : '⏸ Auto-continue disabled',
    'info'
  );
  
  return autoContinueState.enabled;
}

/**
 * Check if response indicates context limit reached
 * @param {string} response - Agent response text
 */
function isContextLimitResponse(response) {
  if (!response) return false;
  
  const indicators = [
    'context limit',
    'token limit',
    'maximum context',
    'context window',
    'continue from where',
    'ran out of context',
    'truncated due to length',
    'I\'ll continue',
    'Let me continue',
    'Continuing from',
  ];
  
  const lowerResponse = response.toLowerCase();
  return indicators.some(ind => lowerResponse.includes(ind.toLowerCase()));
}

/**
 * Check if we should auto-continue
 * @param {Object} msg - Agent message
 */
function shouldAutoContinue(msg) {
  if (!autoContinueState.enabled) return false;
  if (autoContinueState.currentRetries >= autoContinueState.maxRetries) return false;
  
  // Check minimum interval
  const now = Date.now();
  if (now - autoContinueState.lastContinueTime < autoContinueState.minContinueInterval) {
    return false;
  }
  
  // Check if message indicates context limit
  if (msg.contextLimitReached) return true;
  if (msg.type === 'agent:context-limit') return true;
  if (msg.response && isContextLimitResponse(msg.response)) return true;
  
  return false;
}

/**
 * Handle potential context limit in agent response
 * @param {Object} msg - Agent message
 */
function handlePotentialContextLimit(msg) {
  if (!shouldAutoContinue(msg)) return false;
  
  console.log('🔄 Context limit detected, auto-continuing...');
  
  autoContinueState.currentRetries++;
  autoContinueState.lastContinueTime = Date.now();
  
  // Show notification
  showNotification(
    `🔄 Context limit reached, auto-continuing (${autoContinueState.currentRetries}/${autoContinueState.maxRetries})...`,
    'info'
  );
  
  // Update UI
  const statusEl = document.getElementById('agentStepDescription');
  if (statusEl) {
    statusEl.innerHTML = `
      <div class="auto-continue-status">
        <div class="continue-icon">🔄</div>
        <div class="continue-text">
          Auto-continuing... (${autoContinueState.currentRetries}/${autoContinueState.maxRetries})
        </div>
        <div class="continue-progress">
          <div class="continue-progress-bar"></div>
        </div>
      </div>
    `;
  }
  
  // Schedule continue
  autoContinueState.pendingContinue = setTimeout(() => {
    triggerContinue();
  }, 1000);
  
  return true;
}

/**
 * Trigger the continue action
 */
function triggerContinue() {
  if (!state.agent?.taskId) {
    console.error('No active task to continue');
    return;
  }
  
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'agent:continue',
      taskId: state.agent.taskId,
      message: 'Please continue from where you left off.',
      retryCount: autoContinueState.currentRetries
    }));
  }
}

/**
 * Reset auto-continue state (call when task completes or is cancelled)
 */
function resetAutoContinue() {
  autoContinueState.currentRetries = 0;
  autoContinueState.lastContinueTime = 0;
  
  if (autoContinueState.pendingContinue) {
    clearTimeout(autoContinueState.pendingContinue);
    autoContinueState.pendingContinue = null;
  }
}

/**
 * Cancel pending auto-continue
 */
function cancelAutoContinue() {
  if (autoContinueState.pendingContinue) {
    clearTimeout(autoContinueState.pendingContinue);
    autoContinueState.pendingContinue = null;
    showNotification('Auto-continue cancelled', 'info');
  }
}

/**
 * Get auto-continue status for UI
 */
function getAutoContinueStatus() {
  return {
    enabled: autoContinueState.enabled,
    retries: autoContinueState.currentRetries,
    maxRetries: autoContinueState.maxRetries,
    pending: !!autoContinueState.pendingContinue
  };
}

// Export functions
window.initAutoContinue = initAutoContinue;
window.toggleAutoContinue = toggleAutoContinue;
window.handlePotentialContextLimit = handlePotentialContextLimit;
window.resetAutoContinue = resetAutoContinue;
window.cancelAutoContinue = cancelAutoContinue;
window.getAutoContinueStatus = getAutoContinueStatus;
window.isContextLimitResponse = isContextLimitResponse;

// Initialize on load
document.addEventListener('DOMContentLoaded', initAutoContinue);
