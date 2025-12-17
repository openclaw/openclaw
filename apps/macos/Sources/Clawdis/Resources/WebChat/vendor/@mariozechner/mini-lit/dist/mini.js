import { html, nothing } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
export function fc(renderFn) {
    return (props) => renderFn(props || {});
}
export function createState(initialState) {
    const listeners = new Set();
    const state = new Proxy(initialState, {
        set(target, prop, value) {
            target[prop] = value;
            for (const listener of listeners) {
                listener();
            }
            return true;
        },
        get(target, prop) {
            if (prop === "__subscribe") {
                return (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                };
            }
            return target[prop];
        },
    });
    return state;
}
export { createRef, html, nothing, ref };
//# sourceMappingURL=mini.js.map