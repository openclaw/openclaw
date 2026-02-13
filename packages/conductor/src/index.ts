/**
 * @aether/conductor — Aether Conductor package
 *
 * "Operation Ouroboros" — Closed-loop external access authorization for AI agents.
 *
 * This package contains the core conductor logic, independent of the main
 * OpenClaw source tree. Integration with OpenClaw's browser, messaging, and
 * config systems is done via dependency injection in the main app's src/conductor/.
 */

// Core orchestrator
export { Conductor } from "./conductor.js";
export type { ConductorOptions } from "./conductor.js";

// Sub-systems
export { createAnalyzer } from "./analyzer.js";
export { createConductorForwarder } from "./forwarder.js";
export { TerminalInterceptor, generateRequestId } from "./interceptor.js";
export { formatInjectionPayload, injectResults, injectDenial, injectTimeout } from "./injector.js";

// All types
export type {
  // Config
  ConductorConfig,
  ConductorAnalyzerConfig,
  ConductorAnalyzerProvider,
  ConductorAuthConfig,
  ConductorBrowserConfig,
  ConductorForwardTarget,
  // Request/response
  ExternalAccessKind,
  ExternalAccessRequest,
  ConductorDecision,
  ConductorAuthorization,
  // Browser
  BrowserAction,
  BrowserActionResult,
  // Injection
  ConductorInjection,
  // Session
  ConductorSessionState,
  ConductorHistoryEntry,
  // Interfaces
  AnalyzerResult,
  ConductorAnalyzer,
  ConductorForwarder,
  ConductorExecutor,
  // Events
  ConductorEvent,
  ConductorEventListener,
} from "./types.js";
