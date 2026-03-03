// Kill beforeunload dialogs — prevents "Leave site?" popups when agent navigates.
// Runs in MAIN world at document_start, before any page scripts execute.
//
// Without this, automated form-filling flows (multi-page forms, government sites)
// get blocked by "Are you sure you want to leave?" dialogs that the agent cannot
// dismiss through CDP alone.

// Block property assignment (window.onbeforeunload = fn)
Object.defineProperty(window, 'onbeforeunload', {
  get: () => null,
  set: () => {},
  configurable: false,
})

// Block addEventListener('beforeunload', ...)
const _addEventListener = EventTarget.prototype.addEventListener
EventTarget.prototype.addEventListener = function (type, fn, opts) {
  if (type === 'beforeunload') return
  return _addEventListener.call(this, type, fn, opts)
}

// Kill any already-registered listeners via returnValue
window.addEventListener(
  'beforeunload',
  (e) => {
    e.stopImmediatePropagation()
    delete e.returnValue
  },
  true,
)
