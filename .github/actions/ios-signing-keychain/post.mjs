#!/usr/bin/env node

import { cleanupOwnedKeychain } from "./keychain.mjs";

cleanupOwnedKeychain().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
