/* oxlint-disable no-underscore-dangle -- `_isatty` / `_setRawMode` are the
   conventional names for "previous" function bindings we restore on spoof
   teardown; the underscore disambiguates from the spoofed identifier. */
// Preloaded via NODE_OPTIONS=--require to make Claude CLI think stdin/stdout
// are real terminals, keeping it in interactive (subscription) mode.

// Property-level spoof
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });

// Native isatty() spoof — tty.isatty(fd) calls libuv directly
const tty = require('node:tty');
const _isatty = tty.isatty;
tty.isatty = function(fd) {
  if (fd === 0 || fd === 1 || fd === 2) {return true;}
  return _isatty(fd);
};

// setRawMode — ink calls this; no-op since we don't have a real terminal
if (!process.stdin.setRawMode) {
  process.stdin.setRawMode = function() { return process.stdin; };
} else {
  const _setRawMode = process.stdin.setRawMode.bind(process.stdin);
  process.stdin.setRawMode = function(mode) {
    try { return _setRawMode(mode); } catch { return process.stdin; }
  };
}

// Terminal dimensions — TUI frameworks read these for layout
if (!process.stdout.columns) {process.stdout.columns = 200;}
if (!process.stdout.rows) {process.stdout.rows = 50;}
if (!process.stderr.columns) {process.stderr.columns = 200;}
if (!process.stderr.rows) {process.stderr.rows = 50;}
