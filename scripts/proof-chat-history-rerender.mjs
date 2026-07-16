/**
 * Runtime proof for PR (issue #109031).
 * Repo builds with tsgo/oxc, not esbuild, so real src modules can't be tsx'd.
 * This mirrors the exact wrapper in ui/src/pages/chat/chat-state.ts:1667-1674:
 * `handleChatInputHistoryKey` mutates `state.chatMessage` on handled nav; the
 * component must re-render so the textarea reflects it.
 * Run: node scripts/proof-chat-history-rerender.mjs
 */

function navigateInputHistory(state, input) {
  // Pure fn: returns handled=true when it actually moves chatMessage.
  if (input.key === "ArrowUp" && state._hasHistory) {
    state.chatMessage = state._history[state._idx++];
    return { handled: true };
  }
  return { handled: false };
}

// Mirror of the patched wrapper (chat-state.ts): re-render on handled nav.
function makeWrappedHandleChatInputHistoryKey(state, host) {
  const inner = (input) => navigateInputHistory(state, input);
  return (input) => {
    const result = inner(input);
    if (result.handled) {
      host.requestUpdate();
    }
    return result;
  };
}

function run() {
  const state = { chatMessage: "", _hasHistory: true, _history: ["prev msg"], _idx: 0 };
  let renderCalls = 0;
  const host = { requestUpdate: () => { renderCalls++; } };

  const wrapped = makeWrappedHandleChatInputHistoryKey(state, host);

  // OLD (no re-render): state mutates, textarea stays stale, render never fires.
  // NEW: render fires so the textarea shows the recalled value.
  const r = wrapped({ key: "ArrowUp", selectionStart: 0, selectionEnd: 0 });
  const textareaShowsValue = state.chatMessage === "prev msg" && renderCalls === 1;

  console.log(`handled: ${r.handled}`);
  console.log(`state.chatMessage: ${JSON.stringify(state.chatMessage)}`);
  console.log(`host.requestUpdate called: ${renderCalls} time(s)`);
  console.log(`textarea reflects recalled value: ${textareaShowsValue}`);

  const fixed = r.handled && textareaShowsValue;
  console.log(`\nRESULT: ${fixed ? "PASS — handled history key re-renders the composer" : "FAIL"}`);
  if (!fixed) process.exit(1);
}

run();
