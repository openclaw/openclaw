/**
 * Mini-lit next generation - Component-aware HTML templates without build steps
 */
// Export everything from component module
export { Component, createComponent, mount, } from "./component.js";
// Export directives
export { directive, isDirective } from "./directives/directive.js";
export { repeat } from "./directives/repeat.js";
// Export everything from signals module
export { computed, effect, ensureSignal, getSignalAdapter, isSignal, preactSignalsAdapter, Signal, setSignalAdapter, signal, } from "./signals.js";
// Export everything from template module
export { html, registerComponent, registerComponents, } from "./template.js";
//# sourceMappingURL=index.js.map