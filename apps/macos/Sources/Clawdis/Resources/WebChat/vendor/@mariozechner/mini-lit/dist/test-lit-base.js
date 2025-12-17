import { MiniButton } from "./ButtonLit.js";
// Test that types work correctly
const button = new MiniButton();
// All properties should be fully typed
button.variant = "destructive"; // ✓ autocompletes with all variant options
button.size = "lg"; // ✓ autocompletes with all size options
button.disabled = true; // ✓ typed as boolean
button.loading = false; // ✓ typed as boolean
button.className = "custom"; // ✓ typed as string
// This should show type errors:
// button.variant = "invalid";   // ❌ Type error - not a valid variant
// button.size = 123;            // ❌ Type error - not a valid size
// button.disabled = "true";     // ❌ Type error - not a boolean
// Component-specific methods work
button.reset();
// Lit lifecycle methods work
button.connectedCallback();
button.requestUpdate();
//# sourceMappingURL=test-lit-base.js.map