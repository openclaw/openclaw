const cp = require("child_process");
const orig = cp.spawn;
cp.spawn = function (cmd, args, opts) {
  const child = orig(cmd, args, opts);
  if (!process.env.__PROOF_INJECT_ERRORS__) return child;
  setTimeout(() => {
    try {
      child.stdout?.emit("error", new Error("simulated stdout error"));
    } catch (_) {}
    try {
      child.stderr?.emit("error", new Error("simulated stderr error"));
    } catch (_) {}
  }, 10);
  return child;
};
