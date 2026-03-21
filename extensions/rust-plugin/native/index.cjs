"use strict";

const path = require("path");
const fs = require("fs");

// Find the .node file
const searchDirs = [
  __dirname || path.dirname(require.resolve("./index.cjs")),
  path.dirname(require.resolve("./index.cjs")),
];

let loaded = false;
for (const dir of searchDirs) {
  const nodePath = path.join(dir, "rust_plugin.node");
  if (fs.existsSync(nodePath)) {
    try {
      const nativeModule = require(nodePath);
      if (nativeModule && Object.keys(nativeModule).length > 0) {
        module.exports = nativeModule;
        loaded = true;
        break;
      }
    } catch {
      // Continue to next path
    }
  }
}

if (!loaded) {
  module.exports = {};
}
