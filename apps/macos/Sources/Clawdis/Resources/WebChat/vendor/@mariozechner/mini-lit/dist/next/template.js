import { parse } from "html-parse-string";
import { isDirective } from "./directives/directive.js";
import { getSignalAdapter, isSignal } from "./signals.js";
let DEBUG = true;
export function setDebug(value) {
    DEBUG = value;
}
// Track cleanups globally for the current render
let currentCleanups = [];
// Runtime object
const runtime = {
    insert(parent, accessor, marker) {
        const signals = getSignalAdapter();
        // Check if it's a signal or function
        // Support both our Signal wrapper and raw signals from adapter
        if (typeof accessor === "function" || isSignal(accessor) || signals.isRawSignal(accessor)) {
            // This could be reactive - wrap in an effect
            let currentNodes = [];
            let disposeEffect;
            const updateContent = () => {
                try {
                    // Remove old nodes
                    for (const entry of currentNodes) {
                        entry.cleanup?.();
                        entry.node.parentNode?.removeChild(entry.node);
                    }
                    currentNodes = [];
                    // Get new value
                    const value = typeof accessor === "function" ? accessor() : signals.getValue(accessor);
                    // Insert new content
                    const insertNode = (content) => {
                        if (content == null || content === "")
                            return;
                        const appendNode = (node, cleanup) => {
                            if (marker) {
                                parent.insertBefore(node, marker);
                            }
                            else {
                                parent.appendChild(node);
                            }
                            currentNodes.push({ node, cleanup });
                        };
                        if (Array.isArray(content)) {
                            content.forEach(insertNode);
                            return;
                        }
                        if (isDirective(content)) {
                            appendNode(content.node, content.unmount);
                            content.mount();
                            return;
                        }
                        if (content instanceof Node) {
                            appendNode(content);
                            return;
                        }
                        appendNode(document.createTextNode(String(content)));
                    };
                    insertNode(value);
                }
                catch (error) {
                    console.error("Effect error:", error);
                    // Continue to function even if one effect fails
                }
            };
            // Use effect to make it reactive and store dispose function
            disposeEffect = signals.createEffect(updateContent);
            // Return cleanup function
            return () => {
                disposeEffect?.();
                for (const entry of currentNodes) {
                    entry.cleanup?.();
                    entry.node.parentNode?.removeChild(entry.node);
                }
            };
        }
        else if (isDirective(accessor)) {
            const { node, mount, unmount } = accessor;
            if (marker) {
                parent.insertBefore(node, marker);
            }
            else {
                parent.appendChild(node);
            }
            mount();
            // Return cleanup for directives
            return unmount;
        }
        else if (accessor == null || accessor === "") {
            // Skip null/undefined/empty
            return;
        }
        else if (Array.isArray(accessor)) {
            // Array of values - track cleanups
            const cleanups = [];
            for (const item of accessor) {
                const cleanup = this.insert(parent, item, marker);
                if (cleanup)
                    cleanups.push(cleanup);
            }
            // Return combined cleanup
            if (cleanups.length > 0) {
                return () => {
                    for (const cleanup of cleanups) {
                        cleanup?.();
                    }
                };
            }
        }
        else if (accessor instanceof Node) {
            // DOM node
            if (marker) {
                parent.insertBefore(accessor, marker);
            }
            else {
                parent.appendChild(accessor);
            }
        }
        else {
            // Text content
            const text = document.createTextNode(String(accessor));
            if (marker) {
                parent.insertBefore(text, marker);
            }
            else {
                parent.appendChild(text);
            }
        }
    },
    createComponent(Comp, props) {
        if (!Comp) {
            if (DEBUG)
                console.error("Component not found:", Comp);
            return document.createTextNode("[Component not found]");
        }
        // Handle children - wrap in accessor function if needed
        if (props.children !== undefined && typeof props.children !== "function") {
            const children = props.children;
            props.children = () => children;
        }
        // Create component instance
        const instance = new Comp(props);
        // For debugging
        if (DEBUG)
            console.log("Creating component:", Comp.name, "with props:", props);
        const container = document.createElement("div");
        instance.mount(container);
        // Track the instance for cleanup if we're in a component render
        if (currentCleanups !== null) {
            currentCleanups.push(() => instance.unmount());
        }
        // Return the child nodes directly
        const nodes = Array.from(container.childNodes);
        return nodes.length === 1 ? nodes[0] : nodes;
    },
    addEventListener(node, name, handler) {
        const signals = getSignalAdapter();
        if (DEBUG)
            console.log("Adding event listener:", name, "to", node, "handler:", handler);
        // Handle reactive handlers
        if (typeof handler === "function" || isSignal(handler) || signals.isRawSignal(handler)) {
            let currentHandler;
            const updateHandler = () => {
                try {
                    const newHandler = typeof handler === "function" ? handler : signals.getValue(handler);
                    if (currentHandler && currentHandler !== newHandler) {
                        node.removeEventListener(name, currentHandler);
                    }
                    if (newHandler) {
                        currentHandler = newHandler;
                        node.addEventListener(name, currentHandler);
                    }
                }
                catch (error) {
                    console.error("addEventListener effect error:", error);
                }
            };
            // If reactive, use effect
            if (isSignal(handler) || signals.isRawSignal(handler)) {
                const dispose = signals.createEffect(updateHandler);
                return () => {
                    dispose?.();
                    if (currentHandler) {
                        node.removeEventListener(name, currentHandler);
                    }
                };
            }
            else {
                // Static handler
                node.addEventListener(name, handler);
                return () => node.removeEventListener(name, handler);
            }
        }
    },
    setAttribute(node, name, value) {
        const signals = getSignalAdapter();
        // Check if value is reactive
        if (typeof value === "function" || isSignal(value) || signals.isRawSignal(value)) {
            // Create effect for reactive attributes and return cleanup
            const dispose = signals.createEffect(() => {
                try {
                    const actualValue = typeof value === "function" ? value() : isSignal(value) ? value.value : signals.getValue(value);
                    if (actualValue == null || actualValue === false) {
                        node.removeAttribute(name);
                    }
                    else if (actualValue === true) {
                        // Boolean attribute - set empty string
                        node.setAttribute(name, "");
                    }
                    else {
                        node.setAttribute(name, String(actualValue));
                    }
                }
                catch (error) {
                    console.error("setAttribute effect error:", error);
                }
            });
            return dispose;
        }
        else {
            // Static value
            if (value == null || value === false) {
                node.removeAttribute(name);
            }
            else if (value === true) {
                node.setAttribute(name, "");
            }
            else {
                node.setAttribute(name, String(value));
            }
        }
    },
    setProperty(node, name, value) {
        const signals = getSignalAdapter();
        // Check if value is reactive (signal or function)
        if (typeof value === "function" || isSignal(value) || signals.isRawSignal(value)) {
            // Create an effect to keep the property in sync and return cleanup
            const dispose = signals.createEffect(() => {
                try {
                    const actualValue = typeof value === "function" ? value() : isSignal(value) ? value.value : signals.getValue(value);
                    node[name] = actualValue;
                }
                catch (error) {
                    console.error("setProperty effect error:", error);
                }
            });
            return dispose;
        }
        else {
            // Static value, set once
            node[name] = value;
        }
    },
    setRef(node, callback) {
        if (typeof callback === "function") {
            callback(node);
        }
        else if (callback && typeof callback === "object" && "current" in callback) {
            // Support ref objects like React/Preact
            callback.current = node;
        }
    },
    // Expose isSignal for use in generated code
    isSignal(value) {
        return isSignal(value);
    },
    // Start tracking cleanups for a component render
    startCleanupTracking() {
        currentCleanups = [];
    },
    // Get and reset tracked cleanups
    getTrackedCleanups() {
        const cleanups = currentCleanups;
        currentCleanups = [];
        return cleanups;
    },
};
// Cache for compiled templates
const templateCache = new Map();
const componentRegistry = new Map();
// Register components globally
export function registerComponent(name, component) {
    componentRegistry.set(name, component);
}
export function registerComponents(components) {
    Object.entries(components).forEach(([name, comp]) => {
        componentRegistry.set(name, comp);
    });
}
// Helper to check if tag is a component (starts with uppercase)
function isComponent(tagName) {
    return /^[A-Z]/.test(tagName);
}
// Generate unique IDs
let idCounter = 1;
function uid() {
    return `_$${idCounter++}`;
}
// Compile AST to JavaScript code
function compileNode(node, options) {
    if (node.type === "text") {
        if (node.content?.includes("###")) {
            // Dynamic text - use r.insert
            const parts = node.content.split("###");
            const dynamicCount = parts.length - 1;
            // Handle multiple interpolations with markers to maintain position
            if (dynamicCount > 1 && options.parent) {
                for (let i = 0; i < parts.length; i++) {
                    // Add static text
                    if (parts[i]) {
                        const text = parts[i]
                            .replace(/"/g, '\\"')
                            .replace(/\n/g, "\\n")
                            .replace(/\r/g, "\\r")
                            .replace(/\t/g, "\\t");
                        options.exprs.push(`${options.parent}.appendChild(document.createTextNode("${text}"))`);
                    }
                    // Add marker and dynamic value (except after last part)
                    if (i < parts.length - 1) {
                        const markerId = uid();
                        options.decl.push(`const ${markerId} = document.createComment("")`);
                        options.exprs.push(`${options.parent}.appendChild(${markerId})`);
                        const cleanup = `_cleanup${options.counter}`;
                        options.exprs.push(`const ${cleanup} = r.insert(${options.parent}, values[${options.counter++}], ${markerId})`);
                        if (options.needsCleanup) {
                            options.exprs.push(`if (${cleanup}) _cleanups.push(${cleanup})`);
                        }
                    }
                }
                return "";
            }
            // Single interpolation or no parent - use existing logic
            const exprs = [];
            for (let i = 0; i < parts.length; i++) {
                if (parts[i]) {
                    exprs.push(`"${parts[i]
                        .replace(/"/g, '\\"')
                        .replace(/\n/g, "\\n")
                        .replace(/\r/g, "\\r")
                        .replace(/\t/g, "\\t")}"`);
                }
                if (i < parts.length - 1) {
                    exprs.push(`values[${options.counter++}]`);
                }
            }
            // If we have a parent, insert into it
            if (options.parent) {
                const marker = options.multi && options.path ? options.path : "null";
                const cleanup = `_cleanup${options.counter - 1}`;
                if (exprs.length === 1) {
                    options.exprs.push(`const ${cleanup} = r.insert(${options.parent}, ${exprs[0]}, ${marker})`);
                }
                else {
                    options.exprs.push(`const ${cleanup} = r.insert(${options.parent}, [${exprs.join(", ")}], ${marker})`);
                }
                if (options.needsCleanup) {
                    options.exprs.push(`if (${cleanup}) _cleanups.push(${cleanup})`);
                }
                return "";
            }
            // Return expression for inline use
            return exprs.length === 1 ? exprs[0] : `[${exprs.join(", ")}]`;
        }
        // Static text
        if (options.parent) {
            const text = node.content
                ?.replace(/"/g, '\\"')
                .replace(/\n/g, "\\n")
                .replace(/\r/g, "\\r")
                .replace(/\t/g, "\\t");
            // Skip whitespace-only text nodes between elements
            if (!/^\s*$/.test(node.content || "")) {
                options.exprs.push(`${options.parent}.appendChild(document.createTextNode("${text}"))`);
            }
            return "";
        }
        return `"${node.content
            ?.replace(/"/g, '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t")}"`;
    }
    if (node.type === "comment") {
        if (node.content === "#") {
            // Dynamic content placeholder
            const value = `values[${options.counter++}]`;
            if (options.parent) {
                const marker = options.multi && options.path ? options.path : "null";
                const cleanup = `_cleanup${options.counter - 1}`;
                options.exprs.push(`const ${cleanup} = r.insert(${options.parent}, ${value}, ${marker})`);
                if (options.needsCleanup) {
                    options.exprs.push(`if (${cleanup}) _cleanups.push(${cleanup})`);
                }
                return "";
            }
            return value;
        }
        // Regular comment
        return `document.createComment("${node.content?.replace(/"/g, '\\"')}")`;
    }
    if (node.type === "tag") {
        const tagName = node.name;
        // Check if it's a component
        if (isComponent(tagName)) {
            const props = [];
            // Process attributes as props
            if (node.attrs) {
                for (const attr of node.attrs) {
                    if (attr.value === "###") {
                        props.push(`"${attr.name}": values[${options.counter++}]`);
                    }
                    else if (attr.value.includes("###")) {
                        // Interpolated attribute
                        const parts = attr.value.split("###");
                        const exprs = [];
                        for (let i = 0; i < parts.length; i++) {
                            if (parts[i]) {
                                exprs.push(`"${parts[i]
                                    .replace(/"/g, '\\"')
                                    .replace(/\n/g, "\\n")
                                    .replace(/\r/g, "\\r")
                                    .replace(/\t/g, "\\t")}"`);
                            }
                            if (i < parts.length - 1) {
                                exprs.push(`values[${options.counter++}]`);
                            }
                        }
                        const expr = exprs.length === 1 ? exprs[0] : exprs.join(" + ");
                        props.push(`"${attr.name}": ${expr}`);
                    }
                    else {
                        props.push(`"${attr.name}": "${attr.value
                            .replace(/"/g, '\\"')
                            .replace(/\n/g, "\\n")
                            .replace(/\r/g, "\\r")
                            .replace(/\t/g, "\\t")}"`);
                    }
                }
            }
            // Process children
            if (node.children && node.children.length > 0) {
                const childExprs = [];
                const childOpts = { ...options, parent: undefined };
                for (const child of node.children) {
                    const childCode = compileNode(child, childOpts);
                    if (childCode)
                        childExprs.push(childCode);
                }
                if (childExprs.length > 0) {
                    // Wrap children in a function like Solid does
                    props.push(`"children": () => [${childExprs.join(", ")}]`);
                }
                options.counter = childOpts.counter;
            }
            // Return component call
            const component = `components.get("${tagName}")`;
            const propsObj = props.length > 0 ? `{${props.join(", ")}}` : `{}`;
            return `r.createComponent(${component}, ${propsObj})`;
        }
        // Regular HTML element
        const elemId = uid();
        options.decl.push(`const ${elemId} = document.createElement("${tagName}")`);
        // Process attributes
        if (node.attrs) {
            for (const attr of node.attrs) {
                const name = attr.name;
                const value = attr.value;
                if (name.startsWith("@")) {
                    // Event listener
                    const eventName = name.slice(1);
                    if (value === "###") {
                        const cleanup = `_cleanup_evt${options.counter}`;
                        options.exprs.push(`const ${cleanup} = r.addEventListener(${elemId}, "${eventName}", values[${options.counter++}])`);
                        if (options.needsCleanup) {
                            options.exprs.push(`if (${cleanup}) _cleanups.push(${cleanup})`);
                        }
                    }
                }
                else if (name.startsWith(".")) {
                    // Property binding
                    const propName = name.slice(1);
                    if (value === "###") {
                        const cleanup = `_cleanup_prop${options.counter}`;
                        options.exprs.push(`const ${cleanup} = r.setProperty(${elemId}, "${propName}", values[${options.counter++}])`);
                        if (options.needsCleanup) {
                            options.exprs.push(`if (${cleanup}) _cleanups.push(${cleanup})`);
                        }
                    }
                }
                else if (name === "ref") {
                    // Ref callback
                    if (value === "###") {
                        options.exprs.push(`r.setRef(${elemId}, values[${options.counter++}])`);
                    }
                }
                else if (value === "###") {
                    // Dynamic attribute
                    const cleanup = `_cleanup_attr${options.counter}`;
                    options.exprs.push(`const ${cleanup} = r.setAttribute(${elemId}, "${name}", values[${options.counter++}])`);
                    if (options.needsCleanup) {
                        options.exprs.push(`if (${cleanup}) _cleanups.push(${cleanup})`);
                    }
                }
                else if (value.includes("###")) {
                    // Interpolated attribute - wrap in function to handle signals
                    const parts = value.split("###");
                    const exprs = [];
                    for (let i = 0; i < parts.length; i++) {
                        if (parts[i]) {
                            exprs.push(`"${parts[i]
                                .replace(/"/g, '\\"')
                                .replace(/\n/g, "\\n")
                                .replace(/\r/g, "\\r")
                                .replace(/\t/g, "\\t")}"`);
                        }
                        if (i < parts.length - 1) {
                            const valueRef = `values[${options.counter++}]`;
                            // Let the runtime handle signal unwrapping via the function
                            // If it's a signal, accessing it in the function will track it
                            exprs.push(`(typeof ${valueRef} === 'function' ? ${valueRef}() : r.isSignal(${valueRef}) ? ${valueRef}.value : ${valueRef})`);
                        }
                    }
                    // Wrap in a function so setAttribute creates an effect and tracks signals
                    const expr = exprs.join(" + ");
                    const cleanup = `_cleanup_iattr${options.counter - 1}`;
                    options.exprs.push(`const ${cleanup} = r.setAttribute(${elemId}, "${name}", () => ${expr})`);
                    if (options.needsCleanup) {
                        options.exprs.push(`if (${cleanup}) _cleanups.push(${cleanup})`);
                    }
                }
                else {
                    // Static attribute
                    options.exprs.push(`r.setAttribute(${elemId}, "${name}", "${value
                        .replace(/"/g, '\\"')
                        .replace(/\n/g, "\\n")
                        .replace(/\r/g, "\\r")
                        .replace(/\t/g, "\\t")}")`);
                }
            }
        }
        // Process children
        if (node.children && node.children.length > 0) {
            // Check if we have multiple dynamic children
            let hasDynamic = false;
            for (const child of node.children) {
                if ((child.type === "comment" && child.content === "#") ||
                    (child.type === "text" && child.content?.includes("###"))) {
                    hasDynamic = true;
                    break;
                }
            }
            const childOpts = {
                ...options,
                parent: elemId,
                multi: hasDynamic && node.children.length > 1,
                first: true,
                path: undefined,
            };
            for (const child of node.children) {
                if (childOpts.multi &&
                    (child.type === "comment" || (child.type === "text" && child.content?.includes("###")))) {
                    // For multi mode with dynamic content, create markers
                    const marker = uid();
                    options.decl.push(`const ${marker} = document.createTextNode("")`);
                    options.exprs.push(`${elemId}.appendChild(${marker})`);
                    childOpts.path = marker;
                }
                const childCode = compileNode(child, childOpts);
                if (childCode) {
                    // If child returns a value (element or component), append it
                    if (child.type === "tag") {
                        if (isComponent(child.name)) {
                            options.exprs.push(`r.insert(${elemId}, ${childCode})`);
                        }
                        else {
                            // Regular element - append it
                            options.exprs.push(`${elemId}.appendChild(${childCode})`);
                        }
                    }
                    // Text and comments are handled by r.insert in compileNode
                }
                childOpts.first = false;
            }
            options.counter = childOpts.counter;
        }
        return elemId;
    }
    return "";
}
// Compile template strings to function
function compileTemplate(statics) {
    // Join with markers
    let html = "";
    for (let i = 0; i < statics.length - 1; i++) {
        html += statics[i] + "###";
    }
    html += statics[statics.length - 1];
    // Normalize whitespace
    html = html.replace(/>\s+</g, "><").trim();
    // Parse to AST
    const ast = parse(html);
    // Compile AST to JavaScript
    const options = {
        decl: [],
        exprs: [],
        counter: 0,
        first: true,
        multi: false,
    };
    const roots = [];
    for (const node of ast) {
        const code = compileNode(node, options);
        if (code)
            roots.push(code);
    }
    // Generate function code
    const code = `
    ${options.decl.join(";\n")};
    ${options.exprs.join(";\n")};
    ${roots.length === 1 ? `return ${roots[0]}` : `return [${roots.join(", ")}]`};
  `;
    // Log the generated code for debugging
    if (DEBUG)
        console.log("Generated code for template:", code);
    // Create function
    const fn = new Function("values", "components", "r", code);
    // Create template element for caching
    const template = document.createElement("template");
    return { fn, template };
}
// Main html template tag
export function html(statics, ...values) {
    // Get or compile template
    let compiled = templateCache.get(statics);
    if (!compiled) {
        compiled = compileTemplate(statics);
        templateCache.set(statics, compiled);
    }
    // Execute compiled function
    const result = compiled.fn(values, componentRegistry, runtime);
    if (DEBUG)
        console.log("html() returned:", result);
    return result;
}
// Export for component to use
export const templateRuntime = runtime;
//# sourceMappingURL=template.js.map