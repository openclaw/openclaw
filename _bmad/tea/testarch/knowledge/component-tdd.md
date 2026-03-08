# Component Test-Driven Development Loop

## Principle

Start every UI change with a failing component test (`cy.mount`, Playwright component test, or RTL `render`). Follow the Red-Green-Refactor cycle: write a failing test (red), make it pass with minimal code (green), then improve the implementation (refactor). Ship only after the cycle completes. Keep component tests under 100 lines, isolated with fresh providers per test, and validate accessibility alongside functionality.

## Rationale

Component TDD provides immediate feedback during development. Failing tests (red) clarify requirements before writing code. Minimal implementations (green) prevent over-engineering. Refactoring with passing tests ensures changes don't break functionality. Isolated tests with fresh providers prevent state bleed in parallel runs. Accessibility assertions catch usability issues early. Visual debugging (Cypress runner, Storybook, Playwright trace viewer) accelerates diagnosis when tests fail.

## Pattern Examples

### Example 1: Red-Green-Refactor Loop

**Context**: When building a new component, start with a failing test that describes the desired behavior. Implement just enough to pass, then refactor for quality.

**Implementation**:

```typescript
// Step 1: RED - Write failing test
// Button.cy.tsx (Cypress Component Test)
import { Button } from './Button';

describe('Button Component', () => {
  it('should render with label', () => {
    cy.mount(<Button label="Click Me" />);
    cy.contains('Click Me').should('be.visible');
  });

  it('should call onClick when clicked', () => {
    const onClickSpy = cy.stub().as('onClick');
    cy.mount(<Button label="Submit" onClick={onClickSpy} />);

    cy.get('button').click();
    cy.get('@onClick').should('have.been.calledOnce');
  });
});

// Run test: FAILS - Button component doesn't exist yet
// Error: "Cannot find module './Button'"

// Step 2: GREEN - Minimal implementation
// Button.tsx
type ButtonProps = {
  label: string;
  onClick?: () => void;
};

export const Button = ({ label, onClick }: ButtonProps) => {
  return <button onClick={onClick}>{label}</button>;
};

// Run test: PASSES - Component renders and handles clicks

// Step 3: REFACTOR - Improve implementation
// Add disabled state, loading state, variants
type ButtonProps = {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
};

export const Button = ({
  label,
  onClick,
  disabled = false,
  loading = false,
  variant = 'primary'
}: ButtonProps) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`btn btn-${variant}`}
      data-testid="button"
    >
      {loading ? <Spinner /> : label}
    </button>
  );
};

// Step 4: Expand tests for new features
describe('Button Component', () => {
  it('should render with label', () => {
    cy.mount(<Button label="Click Me" />);
    cy.contains('Click Me').should('be.visible');
  });

  it('should call onClick when clicked', () => {
    const onClickSpy = cy.stub().as('onClick');
    cy.mount(<Button label="Submit" onClick={onClickSpy} />);

    cy.get('button').click();
    cy.get('@onClick').should('have.been.calledOnce');
  });

  it('should be disabled when disabled prop is true', () => {
    cy.mount(<Button label="Submit" disabled={true} />);
    cy.get('button').should('be.disabled');
  });

  it('should show spinner when loading', () => {
    cy.mount(<Button label="Submit" loading={true} />);
    cy.get('[data-testid="spinner"]').should('be.visible');
    cy.get('button').should('be.disabled');
  });

  it('should apply variant styles', () => {
    cy.mount(<Button label="Delete" variant="danger" />);
    cy.get('button').should('have.class', 'btn-danger');
  });
});

// Run tests: ALL PASS - Refactored component still works

// Playwright Component Test equivalent
import { test, expect } from '@playwright/experimental-ct-react';
import { Button } from './Button';

test.describe('Button Component', () => {
  test('should call onClick when clicked', async ({ mount }) => {
    let clicked = false;
    const component = await mount(
      <Button label="Submit" onClick={() => { clicked = true; }} />
    );

    await component.getByRole('button').click();
    expect(clicked).toBe(true);
  });

  test('should be disabled when loading', async ({ mount }) => {
    const component = await mount(<Button label="Submit" loading={true} />);
    await expect(component.getByRole('button')).toBeDisabled();
    await expect(component.getByTestId('spinner')).toBeVisible();
  });
});
```

**Key Points**:

- Red: Write failing test first - clarifies requirements before coding
- Green: Implement minimal code to pass - prevents over-engineering
- Refactor: Improve code quality while keeping tests green
- Expand: Add tests for new features after refactoring
- Cycle repeats: Each new feature starts with a failing test

### Example 2: Provider Isolation Pattern

**Context**: When testing components that depend on context providers (React Query, Auth, Router), wrap them with required providers in each test to prevent state bleed between tests.

**Implementation**:

```typescript
// test-utils/AllTheProviders.tsx
import { FC, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '../contexts/AuthContext';

type Props = {
  children: ReactNode;
  initialAuth?: { user: User | null; token: string | null };
};

export const AllTheProviders: FC<Props> = ({ children, initialAuth }) => {
  // Create NEW QueryClient per test (prevent state bleed)
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider initialAuth={initialAuth}>
          {children}
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
};

// Cypress custom mount command
// cypress/support/component.tsx
import { mount } from 'cypress/react18';
import { AllTheProviders } from '../../test-utils/AllTheProviders';

Cypress.Commands.add('wrappedMount', (component, options = {}) => {
  const { initialAuth, ...mountOptions } = options;

  return mount(
    <AllTheProviders initialAuth={initialAuth}>
      {component}
    </AllTheProviders>,
    mountOptions
  );
});

// Usage in tests
// UserProfile.cy.tsx
import { UserProfile } from './UserProfile';

describe('UserProfile Component', () => {
  it('should display user when authenticated', () => {
    const user = { id: 1, name: 'John Doe', email: 'john@example.com' };

    cy.wrappedMount(<UserProfile />, {
      initialAuth: { user, token: 'fake-token' }
    });

    cy.contains('John Doe').should('be.visible');
    cy.contains('john@example.com').should('be.visible');
  });

  it('should show login prompt when not authenticated', () => {
    cy.wrappedMount(<UserProfile />, {
      initialAuth: { user: null, token: null }
    });

    cy.contains('Please log in').should('be.visible');
  });
});

// Playwright Component Test with providers
import { test, expect } from '@playwright/experimental-ct-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserProfile } from './UserProfile';
import { AuthProvider } from '../contexts/AuthContext';

test.describe('UserProfile Component', () => {
  test('should display user when authenticated', async ({ mount }) => {
    const user = { id: 1, name: 'John Doe', email: 'john@example.com' };
    const queryClient = new QueryClient();

    const component = await mount(
      <QueryClientProvider client={queryClient}>
        <AuthProvider initialAuth={{ user, token: 'fake-token' }}>
          <UserProfile />
        </AuthProvider>
      </QueryClientProvider>
    );

    await expect(component.getByText('John Doe')).toBeVisible();
    await expect(component.getByText('john@example.com')).toBeVisible();
  });
});
```

**Key Points**:

- Create NEW providers per test (QueryClient, Router, Auth)
- Prevents state pollution between tests
- `initialAuth` prop allows testing different auth states
- Custom mount command (`wrappedMount`) reduces boilerplate
- Providers wrap component, not the entire test suite

### Example 3: Accessibility Assertions

**Context**: When testing components, validate accessibility alongside functionality using axe-core, ARIA roles, labels, and keyboard navigation.

**Implementation**:

```typescript
// Cypress with axe-core
// cypress/support/component.tsx
import 'cypress-axe';

// Form.cy.tsx
import { Form } from './Form';

describe('Form Component Accessibility', () => {
  beforeEach(() => {
    cy.wrappedMount(<Form />);
    cy.injectAxe(); // Inject axe-core
  });

  it('should have no accessibility violations', () => {
    cy.checkA11y(); // Run axe scan
  });

  it('should have proper ARIA labels', () => {
    cy.get('input[name="email"]').should('have.attr', 'aria-label', 'Email address');
    cy.get('input[name="password"]').should('have.attr', 'aria-label', 'Password');
    cy.get('button[type="submit"]').should('have.attr', 'aria-label', 'Submit form');
  });

  it('should support keyboard navigation', () => {
    // Tab through form fields
    cy.get('input[name="email"]').focus().type('test@example.com');
    cy.realPress('Tab'); // cypress-real-events plugin
    cy.focused().should('have.attr', 'name', 'password');

    cy.focused().type('password123');
    cy.realPress('Tab');
    cy.focused().should('have.attr', 'type', 'submit');

    cy.realPress('Enter'); // Submit via keyboard
    cy.contains('Form submitted').should('be.visible');
  });

  it('should announce errors to screen readers', () => {
    cy.get('button[type="submit"]').click(); // Submit without data

    // Error has role="alert" and aria-live="polite"
    cy.get('[role="alert"]')
      .should('be.visible')
      .and('have.attr', 'aria-live', 'polite')
      .and('contain', 'Email is required');
  });

  it('should have sufficient color contrast', () => {
    cy.checkA11y(null, {
      rules: {
        'color-contrast': { enabled: true }
      }
    });
  });
});

// Playwright with axe-playwright
import { test, expect } from '@playwright/experimental-ct-react';
import AxeBuilder from '@axe-core/playwright';
import { Form } from './Form';

test.describe('Form Component Accessibility', () => {
  test('should have no accessibility violations', async ({ mount, page }) => {
    await mount(<Form />);

    const accessibilityScanResults = await new AxeBuilder({ page })
      .analyze();

    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('should support keyboard navigation', async ({ mount, page }) => {
    const component = await mount(<Form />);

    await component.getByLabel('Email address').fill('test@example.com');
    await page.keyboard.press('Tab');

    await expect(component.getByLabel('Password')).toBeFocused();

    await component.getByLabel('Password').fill('password123');
    await page.keyboard.press('Tab');

    await expect(component.getByRole('button', { name: 'Submit form' })).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(component.getByText('Form submitted')).toBeVisible();
  });
});
```

**Key Points**:

- Use `cy.checkA11y()` (Cypress) or `AxeBuilder` (Playwright) for automated accessibility scanning
- Validate ARIA roles, labels, and live regions
- Test keyboard navigation (Tab, Enter, Escape)
- Ensure errors are announced to screen readers (`role="alert"`, `aria-live`)
- Check color contrast meets WCAG standards

### Example 4: Visual Regression Test

**Context**: When testing components, capture screenshots to detect unintended visual changes. Use Playwright visual comparison or Cypress snapshot plugins.

**Implementation**:

```typescript
// Playwright visual regression
import { test, expect } from '@playwright/experimental-ct-react';
import { Button } from './Button';

test.describe('Button Visual Regression', () => {
  test('should match primary button snapshot', async ({ mount }) => {
    const component = await mount(<Button label="Primary" variant="primary" />);

    // Capture and compare screenshot
    await expect(component).toHaveScreenshot('button-primary.png');
  });

  test('should match secondary button snapshot', async ({ mount }) => {
    const component = await mount(<Button label="Secondary" variant="secondary" />);
    await expect(component).toHaveScreenshot('button-secondary.png');
  });

  test('should match disabled button snapshot', async ({ mount }) => {
    const component = await mount(<Button label="Disabled" disabled={true} />);
    await expect(component).toHaveScreenshot('button-disabled.png');
  });

  test('should match loading button snapshot', async ({ mount }) => {
    const component = await mount(<Button label="Loading" loading={true} />);
    await expect(component).toHaveScreenshot('button-loading.png');
  });
});

// Cypress visual regression with percy or snapshot plugins
import { Button } from './Button';

describe('Button Visual Regression', () => {
  it('should match primary button snapshot', () => {
    cy.wrappedMount(<Button label="Primary" variant="primary" />);

    // Option 1: Percy (cloud-based visual testing)
    cy.percySnapshot('Button - Primary');

    // Option 2: cypress-plugin-snapshots (local snapshots)
    cy.get('button').toMatchImageSnapshot({
      name: 'button-primary',
      threshold: 0.01 // 1% threshold for pixel differences
    });
  });

  it('should match hover state', () => {
    cy.wrappedMount(<Button label="Hover Me" />);
    cy.get('button').realHover(); // cypress-real-events
    cy.percySnapshot('Button - Hover State');
  });

  it('should match focus state', () => {
    cy.wrappedMount(<Button label="Focus Me" />);
    cy.get('button').focus();
    cy.percySnapshot('Button - Focus State');
  });
});

// Playwright configuration for visual regression
// playwright.config.ts
export default defineConfig({
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 100, // Allow 100 pixels difference
      threshold: 0.2 // 20% threshold
    }
  },
  use: {
    screenshot: 'only-on-failure'
  }
});

// Update snapshots when intentional changes are made
// npx playwright test --update-snapshots
```

**Key Points**:

- Playwright: Use `toHaveScreenshot()` for built-in visual comparison
- Cypress: Use Percy (cloud) or snapshot plugins (local) for visual testing
- Capture different states: default, hover, focus, disabled, loading
- Set threshold for acceptable pixel differences (avoid false positives)
- Update snapshots when visual changes are intentional
- Visual tests catch unintended CSS/layout regressions

## Integration Points

- **Used in workflows**: `*atdd` (component test generation), `*automate` (component test expansion), `*framework` (component testing setup)
- **Related fragments**:
  - `test-quality.md` - Keep component tests <100 lines, isolated, focused
  - `fixture-architecture.md` - Provider wrapping patterns, custom mount commands
  - `data-factories.md` - Factory functions for component props
  - `test-levels-framework.md` - When to use component tests vs E2E tests

## TDD Workflow Summary

**Red-Green-Refactor Cycle**:

1. **Red**: Write failing test describing desired behavior
2. **Green**: Implement minimal code to make test pass
3. **Refactor**: Improve code quality, tests stay green
4. **Repeat**: Each new feature starts with failing test

**Component Test Checklist**:

- [ ] Test renders with required props
- [ ] Test user interactions (click, type, submit)
- [ ] Test different states (loading, error, disabled)
- [ ] Test accessibility (ARIA, keyboard navigation)
- [ ] Test visual regression (snapshots)
- [ ] Isolate with fresh providers (no state bleed)
- [ ] Keep tests <100 lines (split by intent)

_Source: CCTDD repository, Murat component testing talks, Playwright/Cypress component testing docs._
