import type { PortListener, PortListenerKind, PortUsage } from "./ports-types.js";
export declare function classifyPortListener(listener: PortListener, port: number): PortListenerKind;
export declare function buildPortHints(listeners: PortListener[], port: number): string[];
export declare function formatPortListener(listener: PortListener): string;
export declare function formatPortDiagnostics(diagnostics: PortUsage): string[];
