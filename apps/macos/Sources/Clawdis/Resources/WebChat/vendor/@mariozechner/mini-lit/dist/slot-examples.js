var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
// ============================================================================
// SHADOW DOM SLOTS - How They Work
// ============================================================================
let ShadowCard = class ShadowCard extends LitElement {
    // Shadow DOM - slots work natively
    render() {
        return html `
      <style>
        .card { border: 1px solid #ccc; padding: 1rem; }
        .header { font-weight: bold; margin-bottom: 0.5rem; }
        .footer { margin-top: 0.5rem; color: #666; }
      </style>
      <div class="card">
        <div class="header">
          <slot name="header">Default Header</slot>
        </div>
        <div class="content">
          <slot>Default Content</slot> <!-- Unnamed/default slot -->
        </div>
        <div class="footer">
          <slot name="footer">Default Footer</slot>
        </div>
      </div>
    `;
    }
};
ShadowCard = __decorate([
    customElement('shadow-card')
], ShadowCard);
export { ShadowCard };
// Usage:
// <shadow-card>
//   <h2 slot="header">My Title</h2>
//   <p>This goes to default slot</p>
//   <p>So does this</p>
//   <small slot="footer">Copyright 2024</small>
// </shadow-card>
// ============================================================================
// LIGHT DOM SLOT SIMULATION - Manual Implementation
// ============================================================================
let LightCardManual = class LightCardManual extends LitElement {
    constructor() {
        super(...arguments);
        this._slots = { header: [], footer: [], default: [] };
    }
    createRenderRoot() { return this; } // Light DOM
    connectedCallback() {
        super.connectedCallback();
        this.style.display = 'block';
        // Store original children before rendering
        this._processSlots();
    }
    _processSlots() {
        // Get all children and categorize by slot attribute
        const children = Array.from(this.children);
        this._slots = {
            header: children.filter(child => child.getAttribute('slot') === 'header'),
            footer: children.filter(child => child.getAttribute('slot') === 'footer'),
            default: children.filter(child => !child.hasAttribute('slot'))
        };
        // Remove children from DOM (we'll re-insert them in render)
        children.forEach(child => child.remove());
    }
    render() {
        return html `
      <div class="card border border-gray-200 rounded p-4">
        <div class="header font-bold mb-2">
          ${this._slots.header.length
            ? this._slots.header
            : html `<span>Default Header</span>`}
        </div>
        <div class="content">
          ${this._slots.default.length
            ? this._slots.default
            : html `<span>Default Content</span>`}
        </div>
        <div class="footer mt-2 text-gray-500 text-sm">
          ${this._slots.footer.length
            ? this._slots.footer
            : html `<span>Default Footer</span>`}
        </div>
      </div>
    `;
    }
};
LightCardManual = __decorate([
    customElement('light-card-manual')
], LightCardManual);
export { LightCardManual };
// ============================================================================
// LIGHT DOM SLOT SIMULATION - Using Data Attributes
// ============================================================================
let LightCardData = class LightCardData extends LitElement {
    constructor() {
        super(...arguments);
        this._slots = new Map();
    }
    createRenderRoot() { return this; }
    connectedCallback() {
        super.connectedCallback();
        this.style.display = 'block';
        this._collectSlots();
    }
    _collectSlots() {
        const slotMap = new Map();
        // Hide original children and categorize them
        Array.from(this.children).forEach(child => {
            const slotName = child.getAttribute('data-slot') || 'default';
            if (!slotMap.has(slotName)) {
                slotMap.set(slotName, []);
            }
            slotMap.get(slotName).push(child);
            child.style.display = 'none';
        });
        this._slots = slotMap;
    }
    render() {
        const header = this._slots.get('header')?.[0];
        const footer = this._slots.get('footer')?.[0];
        const content = this._slots.get('default') || [];
        return html `
      <div class="card border border-gray-200 rounded p-4">
        ${header ? html `
          <div class="header font-bold mb-2"
               @click=${() => this._handleSlotClick('header')}>
            ${header.cloneNode(true)}
          </div>
        ` : html `
          <div class="header font-bold mb-2">Default Header</div>
        `}

        <div class="content">
          ${content.length ?
            content.map(el => el.cloneNode(true)) :
            html `Default Content`}
        </div>

        ${footer ? html `
          <div class="footer mt-2 text-gray-500 text-sm">
            ${footer.cloneNode(true)}
          </div>
        ` : html `
          <div class="footer mt-2 text-gray-500 text-sm">Default Footer</div>
        `}
      </div>
    `;
    }
    _handleSlotClick(slotName) {
        console.log(`Clicked slot: ${slotName}`);
    }
};
__decorate([
    state()
], LightCardData.prototype, "_slots", void 0);
LightCardData = __decorate([
    customElement('light-card-data')
], LightCardData);
export { LightCardData };
// ============================================================================
// LIGHT DOM SLOT SIMULATION - Render Props Pattern
// ============================================================================
let LightCardRender = class LightCardRender extends LitElement {
    createRenderRoot() { return this; }
    render() {
        return html `
      <div class="card border border-gray-200 rounded p-4">
        <div class="header font-bold mb-2">
          ${this.header ? this.header() : 'Default Header'}
        </div>
        <div class="content">
          ${this.content ? this.content() : html `<slot></slot>`}
        </div>
        <div class="footer mt-2 text-gray-500 text-sm">
          ${this.footer ? this.footer() : 'Default Footer'}
        </div>
      </div>
    `;
    }
};
__decorate([
    property({ attribute: false })
], LightCardRender.prototype, "header", void 0);
__decorate([
    property({ attribute: false })
], LightCardRender.prototype, "footer", void 0);
__decorate([
    property({ attribute: false })
], LightCardRender.prototype, "content", void 0);
LightCardRender = __decorate([
    customElement('light-card-render')
], LightCardRender);
export { LightCardRender };
// Usage:
// const card = document.createElement('light-card-render');
// card.header = () => html`<h2>My Title</h2>`;
// card.content = () => html`<p>My Content</p>`;
// card.footer = () => html`<small>Copyright</small>`;
// ============================================================================
// LIGHT DOM SLOT SIMULATION - Query Selectors
// ============================================================================
let LightCardQuery = class LightCardQuery extends LitElement {
    createRenderRoot() { return this; }
    render() {
        // Query for slotted content after render
        requestAnimationFrame(() => {
            this._rearrangeSlots();
        });
        return html `
      <div class="card-header"></div>
      <div class="card-content"></div>
      <div class="card-footer"></div>
    `;
    }
    _rearrangeSlots() {
        const header = this.querySelector('[slot="header"]');
        const footer = this.querySelector('[slot="footer"]');
        const defaultContent = Array.from(this.children).filter(child => !child.hasAttribute('slot') &&
            !child.classList.contains('card-header') &&
            !child.classList.contains('card-content') &&
            !child.classList.contains('card-footer'));
        const headerContainer = this.querySelector('.card-header');
        const contentContainer = this.querySelector('.card-content');
        const footerContainer = this.querySelector('.card-footer');
        if (header && headerContainer) {
            headerContainer.appendChild(header);
        }
        if (footer && footerContainer) {
            footerContainer.appendChild(footer);
        }
        defaultContent.forEach(child => {
            if (contentContainer) {
                contentContainer.appendChild(child);
            }
        });
    }
};
LightCardQuery = __decorate([
    customElement('light-card-query')
], LightCardQuery);
export { LightCardQuery };
// ============================================================================
// BEST PRACTICE: Light DOM Composition Pattern
// ============================================================================
let MiniCard = class MiniCard extends LitElement {
    constructor() {
        super(...arguments);
        this.hasHeader = false;
        this.hasFooter = false;
    }
    createRenderRoot() { return this; }
    connectedCallback() {
        super.connectedCallback();
        this.style.display = 'block';
        // Check if slotted content exists
        this.hasHeader = !!this.querySelector('[slot="header"]');
        this.hasFooter = !!this.querySelector('[slot="footer"]');
        // Hide slotted content initially
        this.querySelectorAll('[slot]').forEach(el => {
            el.dataset.originalDisplay =
                el.style.display || 'block';
            el.style.display = 'none';
        });
    }
    firstUpdated() {
        this._distributeSlots();
    }
    _distributeSlots() {
        // Move slotted content to appropriate containers
        const headerSlot = this.querySelector('[slot="header"]');
        const footerSlot = this.querySelector('[slot="footer"]');
        const defaultContent = Array.from(this.children).filter(child => !child.hasAttribute('slot') &&
            !child.classList.contains('mini-card-section'));
        if (headerSlot) {
            const container = this.querySelector('.mini-card-header');
            if (container) {
                headerSlot.style.display =
                    headerSlot.dataset.originalDisplay || 'block';
                container.appendChild(headerSlot);
            }
        }
        if (footerSlot) {
            const container = this.querySelector('.mini-card-footer');
            if (container) {
                footerSlot.style.display =
                    footerSlot.dataset.originalDisplay || 'block';
                container.appendChild(footerSlot);
            }
        }
        const contentContainer = this.querySelector('.mini-card-content');
        if (contentContainer) {
            defaultContent.forEach(child => {
                contentContainer.appendChild(child);
            });
        }
    }
    render() {
        return html `
      <div class="mini-card border border-gray-200 rounded-lg overflow-hidden">
        ${this.hasHeader ? html `
          <div class="mini-card-header mini-card-section bg-gray-50 px-4 py-3 border-b">
            <!-- Header content will be moved here -->
          </div>
        ` : ''}

        <div class="mini-card-content mini-card-section px-4 py-4">
          <!-- Default content will be moved here -->
        </div>

        ${this.hasFooter ? html `
          <div class="mini-card-footer mini-card-section bg-gray-50 px-4 py-3 border-t">
            <!-- Footer content will be moved here -->
          </div>
        ` : ''}
      </div>
    `;
    }
};
__decorate([
    property({ type: Boolean })
], MiniCard.prototype, "hasHeader", void 0);
__decorate([
    property({ type: Boolean })
], MiniCard.prototype, "hasFooter", void 0);
MiniCard = __decorate([
    customElement('mini-card')
], MiniCard);
export { MiniCard };
// ============================================================================
// Usage Examples
// ============================================================================
let SlotDemoPage = class SlotDemoPage extends LitElement {
    createRenderRoot() { return this; }
    render() {
        return html `
      <div class="p-8 space-y-8 max-w-4xl mx-auto">
        <h1 class="text-2xl font-bold">Slot Simulation in Light DOM</h1>

        <section>
          <h2 class="text-xl font-semibold mb-4">Shadow DOM (Native Slots)</h2>
          <shadow-card>
            <h3 slot="header">Custom Header</h3>
            <p>This is the main content</p>
            <p>Multiple elements go to default slot</p>
            <div slot="footer">Custom Footer</div>
          </shadow-card>
        </section>

        <section>
          <h2 class="text-xl font-semibold mb-4">Light DOM (Manual Slots)</h2>
          <light-card-manual>
            <h3 slot="header">Custom Header</h3>
            <p>This is the main content</p>
            <p>Multiple elements in default slot</p>
            <div slot="footer">Custom Footer</div>
          </light-card-manual>
        </section>

        <section>
          <h2 class="text-xl font-semibold mb-4">Light DOM (Data Attributes)</h2>
          <light-card-data>
            <h3 data-slot="header">Custom Header</h3>
            <p>This is the main content</p>
            <p>Multiple elements in default slot</p>
            <div data-slot="footer">Custom Footer</div>
          </light-card-data>
        </section>

        <section>
          <h2 class="text-xl font-semibold mb-4">Best Practice: Mini Card</h2>
          <mini-card>
            <h3 slot="header">Card Title</h3>
            <p>This is the card content that goes in the default slot.</p>
            <p>You can have multiple paragraphs.</p>
            <div slot="footer">
              <button class="px-3 py-1 bg-blue-500 text-white rounded text-sm">
                Action
              </button>
            </div>
          </mini-card>
        </section>

        <section class="bg-yellow-50 dark:bg-yellow-950 p-4 rounded">
          <h2 class="text-lg font-semibold mb-2">How Shadow DOM Slots Work</h2>
          <ul class="space-y-2 text-sm">
            <li>• <code>&lt;slot&gt;</code> - Default/unnamed slot catches all unassigned content</li>
            <li>• <code>&lt;slot name="header"&gt;</code> - Named slot for specific content</li>
            <li>• <code>slot="header"</code> - Assigns element to named slot</li>
            <li>• Elements without slot attribute go to default slot</li>
            <li>• Slot can have default content shown when empty</li>
          </ul>
        </section>

        <section class="bg-blue-50 dark:bg-blue-950 p-4 rounded">
          <h2 class="text-lg font-semibold mb-2">Light DOM Slot Strategies</h2>
          <ul class="space-y-2 text-sm">
            <li>• <strong>Move DOM:</strong> Physically move elements to containers</li>
            <li>• <strong>Clone Nodes:</strong> Clone and insert (loses event handlers)</li>
            <li>• <strong>Hide/Show:</strong> CSS to control visibility</li>
            <li>• <strong>Render Props:</strong> Pass template functions as props</li>
            <li>• <strong>Data Attributes:</strong> Use data-slot instead of slot</li>
          </ul>
        </section>
      </div>
    `;
    }
};
SlotDemoPage = __decorate([
    customElement('slot-demo-page')
], SlotDemoPage);
export { SlotDemoPage };
//# sourceMappingURL=slot-examples.js.map