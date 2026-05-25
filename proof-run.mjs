#!/usr/bin/env node
// Real behavior proof runner for security-audit command
import { securityAuditCommand } from "./src/commands/security-audit.ts";

const runtime = {
  info: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
  warning: (...args) => console.warn(...args),
  writeRuntimeJson: (data) => console.log("JSON:", JSON.stringify(data, null, 2)),
  exit: (code) => process.exit(code),
};

console.log("=== Running openclaw security-audit (real setup) ===\n");
securityAuditCommand(runtime, {
  includeCredentials: true,
  includePermissions: true,
  includeNetwork: true,
})
  .then((result) => {
    console.log("\n=== Result Summary ===");
    console.log(JSON.stringify(result.summary, null, 2));
  })
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
