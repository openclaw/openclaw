import { html, render, nothing } from 'lit';
import { signal, effect, computed } from '@preact/signals-core';
// Component instance tracking
const componentInstances = new WeakMap();
const cleanupFns = new WeakMap();
// Base Component class - not an HTMLElement!
export class Component {
    constructor(props) {
        this._disposal = new Set();
        this._mounted = false;
        this.props = props;
    }
    // Lifecycle hooks
    onMount() { }
    onUnmount() { }
    onUpdate() { }
    // Mount component into a DOM range
    mount(container, before = null) {
        // Create markers for our DOM range
        this.startMarker = document.createComment(`component-start`);
        this.endMarker = document.createComment(`component-end`);
        this.container = container;
        container.insertBefore(this.startMarker, before);
        container.insertBefore(this.endMarker, before);
        // Track this instance
        componentInstances.set(this.startMarker, this);
        // Create reactive render effect
        const dispose = effect(() => {
            this._render();
        });
        this._disposal.add(dispose);
        this._mounted = true;
        this.onMount();
        return this;
    }
    _render() {
        const template = this.render();
        // Lit can render directly into a container with renderBefore option
        render(template, this.container, {
            renderBefore: this.endMarker
        });
        if (this._mounted) {
            this.onUpdate();
        }
    }
    unmount() {
        this.onUnmount();
        // Clean up effects
        this._disposal.forEach(d => d());
        this._disposal.clear();
        // Remove DOM nodes
        let node = this.startMarker;
        while (node && node !== this.endMarker.nextSibling) {
            const next = node.nextSibling;
            node.remove();
            node = next;
        }
        componentInstances.delete(this.startMarker);
    }
}
// Functional component helper
export function createComponent(renderFn) {
    return class extends Component {
        render() {
            return renderFn(this.props);
        }
    };
}
// State management
export { signal, effect, computed };
// Template literal from Lit
export { html, nothing };
// Component composition helper
export function component(ComponentClass, props) {
    const instance = new ComponentClass(props);
    const container = document.createElement('div');
    instance.mount(container);
    // Return just the children, not the container
    return Array.from(container.childNodes);
}
// ============================================================================
// EXAMPLE USAGE
// ============================================================================
// Simple functional component
const Button = createComponent(props => html `
  <button
    @click=${props.onClick}
    class="px-4 py-2 rounded ${props.variant || 'bg-blue-500 text-white'}"
  >
    ${props.children}
  </button>
`);
// Stateful class component
class Counter extends Component {
    constructor() {
        super(...arguments);
        this.count = signal(0);
        this.increment = () => {
            this.count.value++;
        };
    }
    render() {
        return html `
      <div class="p-4 border rounded">
        <p>Count: ${this.count.value}</p>
        ${component(Button, {
            onClick: this.increment,
            children: 'Increment'
        })}
      </div>
    `;
    }
}
// Complex component with state management
class TodoList extends Component {
    constructor() {
        super(...arguments);
        this.todos = signal([]);
        this.input = signal('');
        this.addTodo = () => {
            if (this.input.value.trim()) {
                this.todos.value = [
                    ...this.todos.value,
                    { id: Date.now(), text: this.input.value, done: false }
                ];
                this.input.value = '';
            }
        };
        this.toggleTodo = (id) => {
            this.todos.value = this.todos.value.map(todo => todo.id === id ? { ...todo, done: !todo.done } : todo);
        };
    }
    render() {
        return html `
      <div class="max-w-md mx-auto p-4">
        <div class="flex gap-2 mb-4">
          <input
            type="text"
            .value=${this.input.value}
            @input=${(e) => {
            this.input.value = e.target.value;
        }}
            @keydown=${(e) => {
            if (e.key === 'Enter')
                this.addTodo();
        }}
            class="flex-1 px-3 py-2 border rounded"
            placeholder="Add todo..."
          />
          ${component(Button, {
            onClick: this.addTodo,
            children: 'Add'
        })}
        </div>

        <ul class="space-y-2">
          ${this.todos.value.map(todo => html `
            <li class="flex items-center gap-2">
              <input
                type="checkbox"
                .checked=${todo.done}
                @change=${() => this.toggleTodo(todo.id)}
              />
              <span class="${todo.done ? 'line-through' : ''}">${todo.text}</span>
            </li>
          `)}
        </ul>
      </div>
    `;
    }
}
// App-level state (global)
export const appState = {
    user: signal(null),
    theme: signal('light'),
};
// Component that uses global state
class UserProfile extends Component {
    render() {
        return html `
      <div class="p-4">
        ${appState.user.value
            ? html `<p>Welcome, ${appState.user.value.name}</p>`
            : html `<p>Not logged in</p>`}
        <button @click=${() => {
            appState.theme.value = appState.theme.value === 'light' ? 'dark' : 'light';
        }}>
          Toggle theme (${appState.theme.value})
        </button>
      </div>
    `;
    }
}
// Mount function for app entry
export function mount(ComponentClass, container, props = {}) {
    const instance = new ComponentClass(props);
    instance.mount(container);
    return instance;
}
// Usage:
// mount(TodoList, document.getElementById('app'));
//# sourceMappingURL=mini-lit-next.js.map