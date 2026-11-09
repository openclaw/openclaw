# Validate the candidate, then the effect

Pick assertions from the requested behavior. Test a clock's changing time, a
filter's selected rows, a threshold's exact boundaries, or a data component's
stale/error recovery. A screenshot alone cannot prove these behaviors.

Before replacing a working component:

- Check the advertised tool schema, capability declarations, size limit, and all
  inline script syntax. `show_widget` performs its own admission checks; its
  rejection is useful feedback, not a reason to bypass them.
- If an admitted preview/test surface exists, render the prepared candidate there
  with synthetic data before publishing. Exercise its controls and expected state
  transitions. Do not execute arbitrary generated code in the host terminal or
  an unsandboxed DOM emulator as a shortcut.
- For an edit, retain the source/name/revision read earlier and recheck if another
  writer may have changed it. Preserve unrelated content. A read revision does
  not make the subsequent write atomic.
- Check the actual narrow and wide page layouts and top-square miniature, accessibility names, readable
  text, focus, and reduced motion. Measure interactive hit areas: at least 44×44
  CSS pixels, even if the visible glyph is smaller. Ensure the target is reachable
  and does not overlap another control; do not accept a CSS declaration without
  checking the resulting layout. Confirm that a graph and its visible label describe
  the same metric and unit: a 40% used arc beside 60% remaining needs an explicit
  visible distinction or a matching remaining arc. Check at least two different
  values and relevant extremes: bars, paths, axes, selected edges, and labels must
  change together. Missing samples must not become invented points or connections.
  Inspect the rendered size of SVG text and the longest control label, not just
  their declared font sizes. Test internal scrolling to the
  last content row when a dense view exceeds the square. Set form-control typography explicitly (for example,
  `button, input, select { font: inherit; }`); browser defaults can shrink labels
  even when the hit area is large. Expand/collapse must retain the same component;
  the host owns the miniature and zoom behavior.
- Exercise visible state transitions, not just selected flags or changed headings. For mutually exclusive views, verify that exactly the intended view is rendered and interactive, including the return path. CSS display rules can override the browser's default treatment of `hidden`; inspect the computed result. Keep active input, derived totals, warnings, and reset behavior coherent across transitions.
- For sources, distinguish a successful real read from seeded responses. Exercise
  empty, invalid, partial, timeout, denied, and stale data relevant to that source. Include an unrelated record with a similar display name when ownership matters; it must not enter the view. Check
  the observed call and returned value for each source, including Refresh; copied
  fixture values with no call cannot establish working data integration. Check
  that the rendered view actually names the source and shows freshness near the
  value, rather than leaving provenance only in code or a tool description. Verify
  no request is made to an undeclared destination and no credential is embedded.
- For external actions, use only an admitted harmless test target. Confirm the
  operation at its owner, including cancellation or rejection. A button handler
  returning is not proof of the external effect; do not replay an uncertain effect.

There is no universal check that proves arbitrary generated programs safe or
correct. Existing runtime isolation and authorization remain mandatory even when
all authoring checks pass. Syntax validation cannot establish visual quality,
business logic, permission, network behavior, or persistence. If a rendered runner
or target is unavailable, name the missing proof rather than claiming full validation.

Use the bounded candidate-repair policy in SKILL.md. Each retry must address a
specific observed failure and rerun the failing check plus affected controls.
Do not automatically publish several candidates or use a different model to
bypass a refusal. After publication, reconcile the board and inspect the actual
component before reporting success.
