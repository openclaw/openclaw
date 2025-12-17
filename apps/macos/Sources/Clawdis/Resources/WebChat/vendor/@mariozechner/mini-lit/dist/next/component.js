import { templateRuntime } from "./template.js";
/**
 * Base component class
 */
export class Component {
    constructor(props) {
        this.cleanups = [];
        this.props = props;
        this.processSlots();
    }
    processSlots() {
        const props = this.props;
        // Materialize children if it's a function (from compiler)
        if (typeof props.children === "function") {
            props.children = props.children();
        }
        // Process declared slots
        const slots = this.constructor.slots || [];
        if (slots.length > 0 && props.children) {
            const children = Array.isArray(props.children) ? props.children : [props.children];
            const unslotted = [];
            // Extract slotted children
            for (const child of children) {
                if (child && child.nodeType === 1) {
                    const slotName = child.getAttribute?.("slot");
                    if (slotName && slots.includes(slotName)) {
                        props[slotName] = child;
                        child.removeAttribute("slot");
                    }
                    else {
                        unslotted.push(child);
                    }
                }
                else {
                    unslotted.push(child);
                }
            }
            // Update children to only unslotted elements
            props.children = unslotted.length === 1 ? unslotted[0] : unslotted;
        }
    }
    mount(container) {
        this.container = container;
        this.update();
        return this;
    }
    addCleanup(cleanup) {
        if (cleanup) {
            this.cleanups.push(cleanup);
        }
    }
    update() {
        if (!this.container)
            return;
        // Clean up existing content and effects
        this.cleanup();
        // Clear DOM
        while (this.container.firstChild) {
            this.container.removeChild(this.container.firstChild);
        }
        // Start tracking cleanups from the template
        templateRuntime.startCleanupTracking();
        // Render new content
        const rendered = this.render();
        // Get cleanups that were tracked during render
        const trackedCleanups = templateRuntime.getTrackedCleanups();
        for (const cleanup of trackedCleanups) {
            if (cleanup)
                this.cleanups.push(cleanup);
        }
        if (!rendered)
            return;
        if (Array.isArray(rendered)) {
            for (const node of rendered) {
                if (node instanceof Node) {
                    this.container.appendChild(node);
                }
                else {
                    this.container.appendChild(document.createTextNode(String(node)));
                }
            }
        }
        else if (rendered instanceof Node) {
            this.container.appendChild(rendered);
        }
        else {
            this.container.appendChild(document.createTextNode(String(rendered)));
        }
    }
    cleanup() {
        // Run all tracked cleanups
        for (const cleanup of this.cleanups) {
            cleanup?.();
        }
        this.cleanups = [];
    }
    unmount() {
        // Run all cleanups
        this.cleanup();
        if (this.dispose) {
            this.dispose();
        }
        // Clear the container
        if (this.container) {
            while (this.container.firstChild) {
                this.container.removeChild(this.container.firstChild);
            }
        }
    }
}
/**
 * Create a functional component
 */
export function createComponent(renderFn, options = {}) {
    var _a;
    return _a = class extends Component {
            render() {
                // Materialize children if it's a function (from compiler)
                const props = { ...this.props };
                if (typeof props.children === "function") {
                    props.children = props.children();
                }
                // Process slots if declared
                if (this.constructor.slots.length > 0) {
                    const slots = this.constructor.slots;
                    const children = Array.isArray(props.children) ? props.children : [props.children];
                    const unslotted = [];
                    // Extract slotted children
                    for (const child of children) {
                        if (child && child.nodeType === 1) {
                            // Element node
                            const slotName = child.getAttribute?.("slot");
                            if (slotName && slots.includes(slotName)) {
                                // Move to named slot prop
                                props[slotName] = child;
                                child.removeAttribute("slot");
                            }
                            else {
                                unslotted.push(child);
                            }
                        }
                        else {
                            unslotted.push(child);
                        }
                    }
                    // Update children to only unslotted elements
                    props.children = unslotted.length === 1 ? unslotted[0] : unslotted;
                }
                return renderFn(props);
            }
        },
        _a.slots = options.slots || [],
        _a;
}
/**
 * Mount a component to a container
 */
export function mount(ComponentClass, container, props = {}) {
    const instance = new ComponentClass(props);
    return instance.mount(container);
}
//# sourceMappingURL=component.js.map