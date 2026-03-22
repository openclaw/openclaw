// Main entry point for the Rust plugin
// This file exports the native module for direct access
const native = require('./native/index.cjs');

// Re-export all native functions
module.exports = native;
