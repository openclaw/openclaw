/**
 * node-transfer version manifest
 * 
 * This file tracks the version and expected file hashes for integrity checking.
 * Update this when any of the core files change.
 */

module.exports = {
    version: "1.0.1",
    description: "High-speed, memory-efficient file transfer between OpenClaw nodes",
    files: {
        // SHA-256 hashes (first 12 chars) of each file
        "send.js": "733a7fec8b5b",
        "receive.js": "154eba4a56c9",
        "ensure-installed.js": "ffdcebe778e2"
    },
    minNodeVersion: "14.0.0"
};
