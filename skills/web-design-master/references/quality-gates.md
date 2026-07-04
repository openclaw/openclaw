# Web design quality gates

A page is not finished because it looks good in one screenshot. Pass the applicable gates before delivery.

## 1. Purpose and hierarchy

- The page purpose is understandable within a few seconds.
- The primary action is visually dominant without overwhelming the page.
- Secondary actions are available but clearly lower priority.
- Content order matches the user's decision or task sequence.
- Important status, risk, ownership, time, and next action are explicit.

## 2. Operational usability

Apply strictly to dashboards, admin panels, support tools, and control planes.

- Frequent actions require few steps and do not move unpredictably.
- Filters, sorting, search, pagination, and saved views behave consistently.
- Tables align numbers, show units, preserve context, and support realistic long values.
- Destructive actions identify the affected object and consequence.
- Bulk actions show selection count and result summary.
- Errors explain what failed, what changed, and what the user can do next.
- Time zones, refresh time, stale data, and data source are visible where relevant.
- Permission-denied states explain the missing access without exposing sensitive details.
- Keyboard navigation supports repeated daily work.

## 3. Visual system

- Typography uses a coherent scale and readable line height.
- Spacing follows a small repeatable scale.
- Color is role-based and semantic, not selected ad hoc per component.
- Borders, shadows, radii, and icon styles are consistent.
- Repeated components have the same anatomy and behavior.
- Visual emphasis corresponds to actual importance.
- Effects such as gradients, blur, glow, or animation have a clear purpose.

## 4. Responsive behavior

Test at minimum:

- 360 px: small mobile
- 768 px: tablet / narrow split view
- 1024 px: laptop / tablet landscape
- 1440 px: standard desktop
- 1920 px: wide desktop

Pass criteria:

- No unintended horizontal scrolling.
- Navigation remains understandable and reachable.
- Content reflows according to priority rather than only shrinking.
- Touch targets remain usable and do not overlap.
- Long labels, translated copy, validation messages, and large numbers do not break layout.
- Tables use an intentional mobile strategy: priority columns, cards, horizontal region, or drill-down.
- Dialogs fit the viewport and keep primary actions reachable.
- Sticky elements do not consume excessive space.

## 5. Accessibility

- Semantic landmarks and heading order describe the page structure.
- Every interactive control has an accessible name.
- Form fields have persistent labels and useful error association.
- Keyboard focus is visible and follows a logical order.
- Interaction does not depend only on hover, color, drag, or pointer precision.
- Text and meaningful UI elements meet suitable contrast.
- Images have appropriate alternative text; decorative images use empty alt text.
- Motion respects `prefers-reduced-motion`.
- The interface remains usable at 200% zoom and with enlarged text.
- Status changes are announced when needed, without excessive live-region noise.

## 6. Complete states

Verify applicable states for every important component:

- default
- hover
- focus-visible
- active / pressed
- selected
- disabled
- loading / skeleton
- empty
- success
- warning
- error
- offline / stale
- unauthorized / forbidden
- partial data
- destructive confirmation

A skeleton should resemble the final layout. An empty state should explain why it is empty and provide the next useful action.

## 7. Content quality

- Headings communicate meaning rather than generic labels such as “Overview.”
- Buttons use action verbs and identify risky consequences.
- Empty and error messages are specific, calm, and actionable.
- Dates, numbers, currencies, and units use consistent formatting.
- Placeholder text is not used as a substitute for a label.
- Public pages contain concrete value, proof, and a clear next step.

## 8. Performance and resilience

- Images use appropriate dimensions and formats.
- Web fonts are limited, subset when practical, and have fallbacks.
- Above-the-fold content does not depend on unnecessary heavy libraries.
- Layout does not jump when content or fonts load.
- Slow, missing, and failed API responses have usable states.
- The page remains understandable when JavaScript-enhanced features fail where practical.

## 9. Browser and input coverage

- Test the project's supported browsers.
- Check keyboard, mouse, touch, and trackpad behavior where relevant.
- Verify date, file, select, and autofill controls on at least one mobile browser when used.
- Confirm that browser zoom and OS-level scaling do not hide controls.

## 10. Final acceptance score

Score each applicable category from 0 to 10:

1. Purpose and hierarchy
2. Task efficiency
3. Visual coherence
4. Responsive behavior
5. Accessibility
6. State completeness
7. Content quality
8. Performance
9. Implementation maintainability
10. Product fit and distinctiveness

Do not call the result finished below 85/100. Any critical accessibility failure, broken primary flow, data-loss risk, or unusable mobile layout blocks delivery regardless of score.
