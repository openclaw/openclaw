---
description: Call this rule/guide when applying background color elevations, tiered color tokens, and state-driven color logic to UI elements in a project
globs: *.tsx, *.jsx, *.css, *.scss, *.json, *.yaml, src/component/ui/
alwaysApply: true
---

# AI-Interpretable Rules for Background Color Elevation in a Design System

## 1. Naming Conventions for Elevation Tokens

1. Token Hierarchy and Naming Structure

1.1. Three-Tier Token Model

All color tokens must follow a structured three-tier hierarchy for maintainability:

Tier	Purpose	Structure	Example
Tier 1	Primitive (Global)	[namespace]-color-[hue]-[scale]	--sys-color-blue-500
Tier 2	Semantic (Alias)	[namespace]-color-[category]-[intent]-[state]	--sys-color-action-primary-hover
Tier 3	Component-Specific	[namespace]-[component]-[element]-[state]	--sys-button-primary-background-active

	•	Primitive Tokens: Define raw colors without context (--sys-color-blue-500).
	•	Semantic Tokens: Map primitives to UI roles (--sys-color-action-primary-default).
	•	Component Tokens: Bind semantics to specific UI components (--sys-button-primary-hover).

2. Elevation Levels and UI Hierarchy

2.1. Defined Elevation Levels
	•	All UI elements must follow the structured elevation model:

Elevation Level	Purpose	Background Token	Shadow Token
Sunken	Recessed UI (input fields, kanban boards)	elevation.surface.sunken	elevation.shadow.none
Default	Standard UI background	elevation.surface.default	elevation.shadow.100
Raised	Elevated components (cards, buttons)	elevation.surface.raised	elevation.shadow.300
Overlay	Floating elements (modals, tooltips)	elevation.surface.overlay	elevation.shadow.600

2.2. Background Color and Shadow Pairing
	•	Every background elevation token must have a paired shadow token:

.component {
  background: var(--elevation-surface-raised);
  box-shadow: var(--elevation-shadow-300);
}


	•	Modals & overlays → Always use elevation.shadow.600+.
	•	Buttons & cards → Use elevation.shadow.200 - 300 for appropriate prominence.

3. State-Driven Color Modifiers

3.1. Required Interactive State Modifiers
	•	All interactive UI components must use state-based token modifiers:

State	Token Structure	Example
Default	[base-token]-default	--sys-color-action-primary-default
Hover	[base-token]-hover	--sys-color-action-primary-hover
Active	[base-token]-active	--sys-color-action-primary-active
Disabled	[base-token]-disabled	--sys-color-action-primary-disabled

	•	Example Implementation (CSS-in-JS):

const Button = styled.button`
  background: var(--sys-color-action-primary-default);
  box-shadow: var(--elevation-shadow-200);

  &:hover {
    background: var(--sys-color-action-primary-hover);
    box-shadow: var(--elevation-shadow-400);
  }

  &:active {
    background: var(--sys-color-action-primary-active);
    box-shadow: var(--elevation-shadow-300);
  }
`;

4. Theming and Mode Variations

4.1. Theme-Based Token Inheritance
	•	Avoid hardcoding theme-specific values. Instead, define theme-aware tokens:

:root {
  --elevation-background-neutral: var(--theme-neutral-100);
}
.dark-mode {
  --elevation-background-neutral: var(--theme-neutral-900);
}


	•	Dark Mode Considerations:
	•	elevation.surface.raised must lighten in dark mode to compensate for reduced shadow contrast.
	•	Use elevation.background.inverse tokens for accessible dark mode surfaces.

5. Accessibility & Contrast Enforcement

5.1. Contrast Ratios
	•	All UI elements must maintain the following WCAG 2.1 contrast ratios:

Content Type	Minimum Contrast Ratio
Text (<24px)	4.5:1
Text (≥24px)	3:1
Essential UI	3:1

5.2. Automated Contrast Enforcement
	•	Use mixins or CSS functions to automatically adjust contrast:

@mixin contrast-safe($background, $text) {
  background: var($background);
  color: var($text);

  @if contrastRatio($background, $text) < 4.5 {
    color: adjustContrast($text, $background, 4.5);
  }
}

.button {
  @include contrast-safe('--sys-button-primary-background', '--sys-button-primary-text');
}

6. Cross-Platform Token Adaptation

6.1. Platform-Specific Token Distribution

Platform	Primitive Format	Semantic Format	Component Format
Android	XML Color	ThemeOverlay	Style Attributes
iOS	Asset Catalog	UIColor Ext.	UIComponent Subclass
Web	CSS Variables	Custom Props	CSS Modules
React Native	JS Object	Theme Provider	Styled Components

6.2. Token Transformation Example
	•	Use Style Dictionary or a similar tool to generate cross-platform tokens:

{
  "source": ["tokens/primitive.json"],
  "platforms": {
    "android": {
      "transformGroup": "android",
      "buildPath": "build/android/",
      "files": [{
        "destination": "colors.xml",
        "format": "android/colors"
      }]
    }
  }
}

7. Governance & Validation Rules

7.1. Automated CI/CD Validation
	•	Token naming rules must be enforced at build time:

- name: Color Token Validator
  uses: design-token-validator@v3
  with:
    rules:
      - pattern: '^--sys-color-(global|alias|component)-[a-z-]+$'
      - requires_reference: true
      - contrast_check:
          foreground: text
          background: surface
          ratio: 4.5



7.2. Token Deprecation Workflow
	•	Mark deprecated tokens with metadata:

{
  "--old-color-token": {
    "value": "#DEPRECATED",
    "meta": {
      "status": "deprecated",
      "replacedBy": "--new-color-token"
    }
  }
}

8. Conclusion

These rules enforce scalable, accessible, and theme-aware color token implementation, ensuring:
✅ Consistent UI hierarchy and elevation levels.
✅ State-driven color logic for interactive elements.
✅ Cross-platform adaptability via structured token inheritance.
✅ Automated accessibility and contrast enforcement.
✅ Governance and validation to prevent naming inconsistencies.

Would you like additional refinements, or should we move to implementation-specific workflows? 🚀