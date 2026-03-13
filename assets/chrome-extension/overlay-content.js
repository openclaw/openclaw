// This script runs in every tab.
// It manages the floating label and aggressively cleans up old versions.

let overlay = null;

function cleanupStale() {
  // Clear EVERY possible legacy ID or class we've ever used
  const staleIds = ['__openclawLockedIcon', '__openclawOverlay'];
  staleIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
  
  // Also look for any element containing the text "OpenClaw" in the bottom right
  const allDivs = document.querySelectorAll('div');
  allDivs.forEach(div => {
    if (div.textContent.includes('OpenClaw') && 
        div.style.position === 'fixed' && 
        (div.style.bottom === '10px' || div.style.right === '10px')) {
      div.remove();
    }
  });
}

function updateOverlay(state) {
  // Always start with a full cleanup of anything old
  cleanupStale();

  if (!state.show) {
    overlay = null;
    return;
  }

  // Create new fresh overlay
  overlay = document.createElement('div');
  overlay.id = '__openclawOverlay';
  Object.assign(overlay.style, {
    position: 'fixed', bottom: '10px', right: '10px',
    color: 'white', padding: '4px 10px', borderRadius: '4px',
    zIndex: '2147483647', fontFamily: 'sans-serif', fontSize: '12px',
    pointerEvents: 'none', transition: 'background-color 0.2s'
  });
  
  const isLocked = state.mode === 'locked';
  overlay.style.backgroundColor = isLocked ? '#10B981' : '#FF5A36';
  overlay.textContent = isLocked ? '🔒 OpenClaw Locked' : '🟢 OpenClaw On';
  
  document.body.appendChild(overlay);
}

// Listen for the background broadcast
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'syncOverlay') {
    updateOverlay(msg.state);
  }
});

// Run a cleanup immediately on load just in case
cleanupStale();
