# Lit to Solid 2

Run from the repository root with the installed native TypeScript parser:

```sh
node scripts/codemods/lit-to-solid.mts ui/src/pages/about ui/src/pages/debug
node scripts/codemods/lit-to-solid.mts --out-dir .artifacts/solid-preview ui/src/pages/about
```

The default is a read-only dry-run: one JSON record per input file lists the
converted template count and source-located decisions. `--out-dir` writes
mirrored `.tsx` copies and refuses to overwrite an existing file. Source files,
imports in other modules, and the application's component registration stay
untouched. Update module paths and callers as part of the component port.

Named and namespace Lit imports are resolved against lexical bindings. Templates
become JSX; custom-element and nonstandard native property bindings use `prop:`;
known native state properties use ordinary JSX. Boolean bindings retain truthy
coercion, and dashed events keep their dashes. Case-sensitive events and unbound
host methods require manual listener conversion.
Text children retain the template's cooked whitespace and decoded entities.
`classMap` and `styleMap` become objects; compound complete class names become
arrays, while dynamic class-name stems remain concatenations. Translation calls
remain unchanged.
Generated child normalization preserves Lit's visible boolean text and iterable
children, including nested collections. Ordinary function children stay text;
only values with a known converted-JSX contract execute as render functions.
Unowned JSX collections remain manual. Compound attributes keep
string coercion and nullish omission. A compound `nothing`/`ifDefined` binding is
left for review because it can remove the entire attribute.

Child ternaries become `Show`. Simple array-map callbacks become positional
`For keyed={false}` callbacks, with an item accessor and numeric index. Three-arg
`repeat` materializes its iterable, retains an item-only key function, and uses item/index accessors. Destructured,
block-bodied, async, reassigning, and `thisArg` callbacks require manual work.
Simple truthy guards use narrowed `Show` accessors where needed; complex
TypeScript narrowing remains marked for review. Unknown or callable-compatible
child types, including structural objects and non-primitive generic constraints,
require an explicit text or JSX decision. Child calls without a known return
contract also remain manual; translation calls and recognized Lit directives
retain their dedicated handling. Generic arrows and angle-bracket
type assertions are converted to their unambiguous TSX equivalents.

The converter preserves unsafe expressions with source-located `TODO(solid2)`
comments: reset/cache/live/async directives, custom directive factories,
controllers, Tasks, lifecycle, and cancellation. An element directive or markup
that needs HTML-parser repair leaves the whole template intact. These files are
intermediate migration work, not finished components. `--check` exits nonzero
when decisions remain, and the regular boundary lint gate rejects the comments.
The converter does not redesign state, synthesize signals, or transfer lifecycle
ownership. Inspect and resolve every marker before landing a port.

Run the independent real-template goldens with:

```sh
pnpm test test/scripts/lit-to-solid.test.ts --maxWorkers=1
```

The [fixture README](../../test/fixtures/lit-to-solid/README.md) describes how to
compile all 40 generated outputs against the installed Solid 2 types.
