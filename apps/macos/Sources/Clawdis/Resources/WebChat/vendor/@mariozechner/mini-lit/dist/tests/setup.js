import { Window } from "happy-dom";
// Setup DOM globals for testing
export function setupDOM() {
    const window = new Window();
    const document = window.document;
    // Set globals with proper type assertions
    global.document = document;
    global.window = window;
    global.Node = window.Node;
    global.Element = window.Element;
    global.HTMLElement = window.HTMLElement;
    global.HTMLInputElement = window.HTMLInputElement;
    global.Text = window.Text;
    global.Comment = window.Comment;
    global.DocumentFragment = window.DocumentFragment;
    global.CustomEvent = window.CustomEvent;
    return { window, document };
}
export function cleanupDOM(window) {
    window.close();
    // Use optional chaining and type assertions for cleanup
    const g = global;
    delete g.document;
    delete g.window;
    delete g.Node;
    delete g.Element;
    delete g.HTMLElement;
    delete g.HTMLInputElement;
    delete g.Text;
    delete g.Comment;
    delete g.DocumentFragment;
    delete g.CustomEvent;
}
// Helper to wait for effects to settle
export function nextTick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
// Helper to track memory leaks
export class MemoryTracker {
    constructor() {
        this.refs = new Set();
    }
    track(obj) {
        this.refs.add(new WeakRef(obj));
    }
    getAliveCount() {
        let alive = 0;
        for (const ref of this.refs) {
            if (ref.deref() !== undefined)
                alive++;
        }
        return alive;
    }
    clear() {
        this.refs.clear();
    }
}
// Helper to capture console errors
export class ErrorCapture {
    constructor() {
        this.errors = [];
    }
    start() {
        this.originalError = console.error;
        console.error = (...args) => {
            this.errors.push(args);
        };
    }
    stop() {
        console.error = this.originalError;
    }
    get() {
        return this.errors;
    }
    clear() {
        this.errors = [];
    }
}
//# sourceMappingURL=setup.js.map