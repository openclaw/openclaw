import { parse } from "html-parse-string";
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
            // Dynamic text
            const parts = node.content.split("###");
            const textExprs = [];
            for (let i = 0; i < parts.length; i++) {
                if (i > 0) {
                    textExprs.push(`values[${options.counter++}]`);
                }
                if (parts[i]) {
                    textExprs.push(`"${parts[i].replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`);
                }
            }
            return textExprs.join(" + ");
        }
        return `"${node.content?.replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
    }
    if (node.type === "comment") {
        if (node.content === "#") {
            // Dynamic content placeholder
            return `values[${options.counter++}]`;
        }
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
                        let expr = "";
                        for (let i = 0; i < parts.length; i++) {
                            if (i > 0)
                                expr += ` + values[${options.counter++}] + `;
                            expr += `"${parts[i].replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
                        }
                        props.push(`"${attr.name}": ${expr}`);
                    }
                    else {
                        props.push(`"${attr.name}": "${attr.value.replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`);
                    }
                }
            }
            // Process children
            if (node.children && node.children.length > 0) {
                const childExprs = [];
                const childOpts = { ...options };
                for (const child of node.children) {
                    const childCode = compileNode(child, childOpts);
                    if (childCode)
                        childExprs.push(childCode);
                }
                if (childExprs.length > 0) {
                    props.push(`"children": [${childExprs.join(", ")}]`);
                }
                options.counter = childOpts.counter;
            }
            // Return component call
            const component = `components.get("${tagName}")`;
            return `createComponentInstance(${component}, {${props.join(", ")}})`;
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
                        options.exprs.push(`${elemId}.addEventListener("${eventName}", values[${options.counter++}])`);
                    }
                }
                else if (name.startsWith(".")) {
                    // Property binding
                    const propName = name.slice(1);
                    if (value === "###") {
                        options.exprs.push(`${elemId}.${propName} = values[${options.counter++}]`);
                    }
                }
                else if (name.startsWith("?")) {
                    // Boolean attribute
                    const attrName = name.slice(1);
                    if (value === "###") {
                        options.exprs.push(`if (values[${options.counter++}]) ${elemId}.setAttribute("${attrName}", "")`);
                    }
                }
                else if (name === "class" && value === "###") {
                    // Dynamic class
                    options.exprs.push(`${elemId}.className = values[${options.counter++}]`);
                }
                else if (value === "###") {
                    // Dynamic attribute
                    options.exprs.push(`${elemId}.setAttribute("${name}", values[${options.counter++}])`);
                }
                else if (value.includes("###")) {
                    // Interpolated attribute
                    const parts = value.split("###");
                    let expr = "";
                    for (let i = 0; i < parts.length; i++) {
                        if (i > 0)
                            expr += ` + values[${options.counter++}] + `;
                        expr += `"${parts[i].replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
                    }
                    options.exprs.push(`${elemId}.setAttribute("${name}", ${expr})`);
                }
                else {
                    // Static attribute
                    options.exprs.push(`${elemId}.setAttribute("${name}", "${value.replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}")`);
                }
            }
        }
        // Process children
        if (node.children && node.children.length > 0) {
            for (const child of node.children) {
                const childCode = compileNode(child, options);
                if (childCode) {
                    if (child.type === "text") {
                        // Check if it has dynamic content
                        if (childCode.includes("values[")) {
                            // Has dynamic content - use appendDynamicContent to handle arrays
                            options.exprs.push(`appendDynamicContent(${elemId}, ${childCode})`);
                        }
                        else {
                            // Pure static text
                            options.exprs.push(`${elemId}.appendChild(document.createTextNode(${childCode}))`);
                        }
                    }
                    else if (child.type === "comment" && child.content === "#") {
                        // Dynamic content - could be text or DOM nodes
                        options.exprs.push(`appendDynamicContent(${elemId}, ${childCode})`);
                    }
                    else if (childCode.startsWith("createComponentInstance")) {
                        // Component child
                        options.exprs.push(`appendComponent(${elemId}, ${childCode})`);
                    }
                    else {
                        // Element child
                        options.exprs.push(`${elemId}.appendChild(${childCode})`);
                    }
                }
            }
        }
        return elemId;
    }
    return "";
}
// Helper to create component instances
function createComponentInstance(ComponentClass, props) {
    if (!ComponentClass) {
        console.error("Component not found:", ComponentClass);
        return document.createTextNode("[Component not found]");
    }
    // Flatten children arrays if present
    if (props.children && Array.isArray(props.children)) {
        const flattened = [];
        for (const child of props.children) {
            if (Array.isArray(child)) {
                flattened.push(...child);
            }
            else {
                flattened.push(child);
            }
        }
        props.children = flattened;
    }
    // For functional components created with createComponent
    const instance = new ComponentClass(props);
    const container = document.createElement("div");
    instance.mount(container);
    return Array.from(container.childNodes);
}
// Helper to append component to parent
function appendComponent(parent, componentNodes) {
    if (Array.isArray(componentNodes)) {
        for (const node of componentNodes) {
            parent.appendChild(node);
        }
    }
    else {
        parent.appendChild(componentNodes);
    }
}
// Helper to append dynamic content (could be text, nodes, or arrays)
function appendDynamicContent(parent, content) {
    if (content == null || content === "") {
        // Skip null/undefined/empty
        return;
    }
    if (Array.isArray(content)) {
        // Array of nodes or values - flatten and append each
        for (const item of content) {
            if (item == null || item === "")
                continue;
            if (item instanceof Node) {
                parent.appendChild(item);
            }
            else if (Array.isArray(item)) {
                appendDynamicContent(parent, item);
            }
            else {
                // Convert to text
                parent.appendChild(document.createTextNode(String(item)));
            }
        }
    }
    else if (content instanceof Node) {
        // DOM node
        parent.appendChild(content);
    }
    else {
        // Convert to text
        parent.appendChild(document.createTextNode(String(content)));
    }
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
    html = html.replace(/>\s+</g, "><").replace(/\s+</g, " <").trim();
    // Parse to AST
    const ast = parse(html);
    // Compile AST to JavaScript
    const options = {
        decl: [],
        exprs: [],
        counter: 0,
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
    console.log("Generated code for template:", code);
    // Create function
    const fn = new Function("values", "components", "createComponentInstance", "appendComponent", "appendDynamicContent", code);
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
    const result = compiled.fn(values, componentRegistry, createComponentInstance, appendComponent, appendDynamicContent);
    console.log("html() returned:", result);
    return result;
}
// Component base class (simplified version)
export class Component {
    constructor(props) {
        this.props = props;
    }
    mount(container) {
        const rendered = this.render();
        if (Array.isArray(rendered)) {
            for (const node of rendered) {
                container.appendChild(node);
            }
        }
        else {
            container.appendChild(rendered);
        }
        return this;
    }
}
// Create functional component
export function createComponent(renderFn) {
    return class extends Component {
        render() {
            return renderFn(this.props);
        }
    };
}
// Mount component
export function mount(ComponentClass, container, props = {}) {
    const instance = new ComponentClass(props);
    return instance.mount(container);
}
// Re-export signals
export { computed, effect, signal } from "@preact/signals-core";
//# sourceMappingURL=html-template.js.map