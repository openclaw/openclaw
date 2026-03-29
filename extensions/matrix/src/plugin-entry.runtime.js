// Thin ESM wrapper so native dynamic import() resolves in source-checkout mode
// where jiti loads index.ts but import("./src/plugin-entry.runtime.js") uses
// Node's native ESM loader which cannot resolve .ts files directly.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = jiti("./plugin-entry.runtime.ts");
export const ensureMatrixCryptoRuntime = mod.ensureMatrixCryptoRuntime;
export const handleVerifyRecoveryKey = mod.handleVerifyRecoveryKey;
export const handleVerificationBootstrap = mod.handleVerificationBootstrap;
export const handleVerificationStatus = mod.handleVerificationStatus;
