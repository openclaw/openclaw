# Mobile Navigation Reference

> Navigation patterns, deep linking, back handling, and tab/stack/drawer decisions.
> **Navigation is the skeleton of your app—get it wrong and everything feels broken.**

---

## 1. Navigation Selection Decision Tree

```
WHAT TYPE OF APP?
        │
        ├── 3-5 top-level sections (equal importance)
        │   └── ✅ Tab Bar / Bottom Navigation
        │       Examples: Social, E-commerce, Utility
        │
        ├── Deep hierarchical content (drill down)
        │   └── ✅ Stack Navigation
        │       Examples: Settings, Email folders
        │
        ├── Many destinations (>5 top-level)
        │   └── ✅ Drawer Navigation
        │       Examples: Gmail, complex enterprise
        │
        ├── Single linear flow
        │   └── ✅ Stack only (wizard/onboarding)
        │       Examples: Checkout, Setup flow
        │
        └── Tablet/Foldable
            └── ✅ Navigation Rail + List-Detail
                Examples: Mail, Notes on iPad
```

---

## 2. Tab Bar Navigation

### When to Use

```
✅ USE Tab Bar when:
├── 3-5 top-level destinations
├── Destinations are of equal importance
├── User frequently switches between them
├── Each tab has independent navigation stack
└── App is used in short sessions

❌ AVOID Tab Bar when:
├── More than 5 destinations
├── Destinations have clear hierarchy
├── Tabs would be used very unequally
└── Content flows in a sequence
```

### Tab Bar Best Practices

```
iOS Tab Bar:
├── Height: 49pt (83pt with home indicator)
├── Max items: 5
├── Icons: SF Symbols, 25×25pt
├── Labels: Always show (accessibility)
├── Active indicator: Tint color

Android Bottom Navigation:
├── Height: 80dp
├── Max items: 5 (3-5 ideal)
├── Icons: Material Symbols, 24dp
├── Labels: Always show
├── Active indicator: Pill shape + filled icon
```

### Tab State Preservation

```
RULE: Each tab maintains its own navigation stack.

User journey:
1. Home tab → Drill into item → Add to cart
2. Switch to Profile tab
3. Switch back to Home tab
→ Should return to "Add to cart" screen, NOT home root

Implementation:
├── React Navigation: Each tab has own navigator
├── Flutter: IndexedStack for state preservation
└── Never reset tab stack on switch
```

---

## 3. Stack Navigation

### Core Concepts

```
Stack metaphor: Cards stacked on top of each other

Push: Add screen on top
Pop: Remove top screen (back)
Replace: Swap current screen
Reset: Clear stack, set new root

Visual: New screen slides in from right (LTR)
Back: Screen slides out to right
```

### Stack Navigation Patterns

| Pattern | Use Case | Implementation |
|---------|----------|----------------|
| **Simple Stack** | Linear flow | Push each step |
| **Nested Stack** | Sections with sub-navigation | Stack inside tab |
| **Modal Stack** | Focused tasks | Present modally |
| **Auth Stack** | Login vs Main | Conditional root |

### Back Button Handling

```
iOS:
├── Edge swipe from left (system)
├── Back button in nav bar (optional)
├── Interactive pop gesture
└── Never override swipe back without good reason

Android:
├── System back button/gesture
├── Up button in toolbar (optional, for drill-down)
├── Predictive back animation (Android 14+)
└── Must handle back correctly (Activity/Fragment)

Cross-Platform Rule:
├── Back ALWAYS navigates up the stack
├── Never hijack back for other purposes
├── Confirm before discarding unsaved data
└── Deep links should allow full back traversal
```

---

## 4. Drawer Navigation

### When to Use

```
✅ USE Drawer when:
├── More than 5 top-level destinations
├── Less frequently accessed destinations
├── Complex app with many features
├── Need for branding/user info in nav
└── Tablet/large screen with persistent drawer

❌ AVOID Drawer when:
├── 5 or fewer destinations (use tabs)
├── All destinations equally important
├── Mobile-first simple app
└── Discoverability is critical (drawer is hidden)
```

### Drawer Patterns

```
Modal Drawer:
├── Opens over content (scrim behind)
├── Swipe to open from edge
├── Hamburger icon ( ☰ ) triggers
└── Most common on mobile

Permanent Drawer:
├── Always visible (large screens)
├── Content shifts over
├── Good for productivity apps
└── Tablets, desktops

Navigation Rail (Android):
├── Narrow vertical strip
├── Icons + optional labels
├── For tablets in portrait
└── 80dp width
```

---

## 5. Modal Navigation

### Modal vs Push

```
PUSH (Stack):                    MODAL:
├── Horizontal slide             ├── Vertical slide up (sheet)
├── Part of hierarchy            ├── Separate task
├── Back returns                 ├── Dismiss (X) returns
├── Same navigation context      ├── Own navigation context
└── "Drill in"                   └── "Focus on task"

USE MODAL for:
├── Creating new content
├── Settings/preferences
├── Completing a transaction
├── Self-contained workflows
├── Quick actions
```

### Modal Types

| Type | iOS | Android | Use Case |
|------|-----|---------|----------|
| **Sheet** | `.sheet` | Bottom Sheet | Quick tasks |
| **Full Screen** | `.fullScreenCover` | Full Activity | Complex forms |
| **Alert** | Alert | Dialog | Confirmations |
| **Action Sheet** | Action Sheet | Menu/Bottom Sheet | Choose from options |

### Modal Dismissal

```
Users expect to dismiss modals by:
├── Tapping X / Close button
├── Swiping down (sheet)
├── Tapping scrim (non-critical)
├── System back (Android)
├── Hardware back (old Android)

RULE: Only block dismissal for unsaved data.
```

---

## 6. Deep Linking

### Why Deep Links from Day One

```
Deep links enable:
├── Push notification navigation
├── Sharing content
├── Marketing campaigns
├── Spotlight/Search integration
├── Widget navigation
├── External app integration

Building later is HARD:
├── Requires navigation refactor
├── Screen dependencies unclear
├── Parameter passing complex
└── Always plan deep links at start
```

### URL Structure

```
Scheme://host/path?params

Examples:
├── myapp://product/123
├── https://myapp.com/product/123 (Universal/App Link)
├── myapp://checkout?promo=SAVE20
├── myapp://tab/profile/settings

Hierarchy should match navigation:
├── myapp://home
├── myapp://home/product/123
├── myapp://home/product/123/reviews
└── URL path = navigation path
```

### Deep Link Navigation Rules

```
1. FULL STACK CONSTRUCTION
   Deep link to myapp://product/123 should:
   ├── Put Home at root of stack
   ├── Push Product screen on top
   └── Back button returns to Home

2. AUTHENTICATION AWARENESS
   If deep link requires auth:
   ├── Save intended destination
   ├── Redirect to login
   ├── After login, navigate to destination

3. INVALID LINKS
   If deep link target doesn't exist:
   ├── Navigate to fallback (home)
   ├── Show error message
   └── Never crash or blank screen

4. STATEFUL NAVIGATION
   Deep link during active session:
   ├── Don't blow away current stack
   ├── Push on top OR
   ├── Ask user if should navigate away
```

---

## 7. Navigation State Persistence

### What to Persist

```
SHOULD persist:
├── Current tab selection
├── Scroll position in lists
├── Form draft data
├── Recent navigation stack
└── User preferences

SHOULD NOT persist:
├── Modal states (dialogs)
├── Temporary UI states
├── Stale data (refresh on return)
├── Authentication state (use secure storage)
```

### Implementation

```javascript
// React Navigation - State Persistence
const [isReady, setIsReady] = useState(false);
const [initialState, setInitialState] = useState();

useEffect(() => {
  const loadState = async () => {
    const savedState = await AsyncStorage.getItem('NAV_STATE');
    if (savedState) setInitialState(JSON.parse(savedState));
    setIsReady(true);
  };
  loadState();
}, []);

const handleStateChange = (state) => {
  AsyncStorage.setItem('NAV_STATE', JSON.stringify(state));
};

<NavigationContainer
  initialState={initialState}
  onStateChange={handleStateChange}
>
```

---

## 8. Transition Animations

### Platform Defaults

```
iOS Transitions:
├── Push: Slide from right
├── Modal: Slide from bottom (sheet) or fade
├── Tab switch: Cross-fade
├── Interactive: Swipe to go back

Android Transitions:
├── Push: Fade + slide from right
├── Modal: Slide from bottom
├── Tab switch: Cross-fade or none
├── Shared element: Hero animations
```

### Custom Transitions

```
When to custom:
├── Brand identity requires it
├── Shared element connections
├── Special reveal effects
└── Keep it subtle, <300ms

When to use default:
├── Most of the time
├── Standard drill-down
├── Platform consistency
└── Performance critical paths
```

### Shared Element Transitions

```
Connect elements between screens:

Screen A: Product card with image
            ↓ (tap)
Screen B: Product detail with same image (expanded)

Image animates from card position to detail position.

Implementation:
├── React Navigation: shared element library
├── Flutter: Hero widget
├── SwiftUI: matchedGeometryEffect
└── Compose: Shared element transitions
```

---

## 9. Navigation Anti-Patterns

### ❌ Navigation Sins

| Anti-Pattern | Problem | Solution |
|--------------|---------|----------|
| **Inconsistent back** | User confused, can't predict | Always pop stack |
| **Hidden navigation** | Features undiscoverable | Visible tabs/drawer trigger |
| **Deep nesting** | User gets lost | Max 3-4 levels, breadcrumbs |
| **Breaking swipe back** | iOS users frustrated | Never override gesture |
| **No deep links** | Can't share, bad notifications | Plan from start |
| **Tab stack reset** | Work lost on switch | Preserve tab states |
| **Modal for primary flow** | Can't back track | Use stack navigation |

### ❌ AI Navigation Mistakes

```
AI tends to:
├── Use modals for everything (wrong)
├── Forget tab state preservation (wrong)
├── Skip deep linking (wrong)
├── Override platform back behavior (wrong)
├── Reset stack on tab switch (wrong)
└── Ignore predictive back (Android 14+)

RULE: Use platform navigation patterns.
Don't reinvent navigation.
```

---

## 10. Navigation Checklist

### Before Navigation Architecture

- [ ] App type determined (tabs/drawer/stack)
- [ ] Number of top-level destinations counted
- [ ] Deep link URL scheme planned
- [ ] Auth flow integrated with navigation
- [ ] Tablet/large screen considered

### Before Every Screen

- [ ] Can user navigate back? (not dead end)
- [ ] Deep link to this screen planned
- [ ] State preserved on navigate away/back
- [ ] Transition appropriate for relationship
- [ ] Auth required? Handled?

### Before Release

- [ ] All deep links tested
- [ ] Back button works everywhere
- [ ] Tab states preserved correctly
- [ ] Edge swipe back works (iOS)
- [ ] Predictive back works (Android 14+)
- [ ] Universal/App links configured
- [ ] Push notification deep links work

---

> **Remember:** Navigation is invisible when done right. Users shouldn't think about HOW to get somewhere—they just get there. If they notice navigation, something is wrong.
