# Measure owner-filtered session refreshes

This benchmark runs the real Control UI session capability against the existing
synthetic list fixture: 25,000 sessions, a 200-row primary window, and a 200-row
owner-filtered window. Each operation updates a known nonowner row and advances
the refresh coordinator six virtual seconds. It checks exact membership in both
windows and the latest primary labels.

CPU and allocation include the synthetic fixture's selection, projection,
serialization accounting, and request diagnostics. They do not measure a real
Gateway, database, network, or renderer. Pair this evidence with the real-Gateway
roster E2E when evaluating a change.

## Prepare frozen owners

Run from the repository root with its existing dependencies. Replace
`<base-commit>` with the commit being compared. This recipe swaps only
`session-list-query.ts`; all other sources remain identical to the candidate
checkout. It isolates that owner's change, rather than comparing whole revisions.

```sh
node --input-type=module - '<base-commit>' <<'JS'
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const base = execFileSync('git', ['rev-parse', '--verify', `${process.argv[2]}^{commit}`], {
  encoding: 'utf8',
}).trim();
const source = 'ui/src/lib/sessions/session-list-query.ts';
const original = execFileSync('git', ['show', `${base}:${source}`], { encoding: 'utf8' });
const output = '.local/session-owner-exclusion';
mkdirSync(output, { recursive: true });
for (const arm of ['base', 'candidate']) {
  await build({
    entryPoints: ['ui/src/lib/sessions/index.ts'],
    outfile: `${output}/${arm}-owner.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
    plugins: [{
      name: 'freeze-session-query-owner',
      setup(builder) {
        // Keep locale adapters lazy: their virtual imports belong to Vite.
        builder.onResolve({ filter: /\/locales\/[^/]+\.ts$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path),
          external: true,
        }));
        if (arm === 'base') {
          builder.onLoad({ filter: /session-list-query\.ts$/ }, () => ({
            contents: original,
            resolveDir: path.resolve('ui/src/lib/sessions'),
            loader: 'ts',
          }));
        }
      },
    }],
  });
}
console.log({ base, output });
JS
```

Keep package dependencies bundled. Adding `packages: 'external'` can make imports
resolve from `.local` instead of their owning workspace package. Preserve these
bundles until every paired run finishes; each report hashes its measured module.

## Run matched samples

First smoke each bundle with `--iterations 2`. Then collect five timing pairs,
alternating base/candidate and candidate/base launch order. Use unique output
names for every arm; the example below is the first base arm.

```sh
uptime
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-owner-exclusion-measure.ts \
  --module .local/session-owner-exclusion/base-owner.mjs \
  --iterations 3000 --output .local/session-owner-exclusion/timing-1-base.json
uptime
```

Use `candidate-owner.mjs` for the other arm. Repeat the matched protocol with
`--allocations` and separate output names. Allocation passes sample collected
objects at 16 KiB intervals; use only untraced passes for timing conclusions.
The default workload is 3,000 measured operations after 100 warmups.

Record the one-minute host load at each pair's start and end. Discard and replace
the entire pair if either exceeds 40, and report the kept load range and discarded
pair count. A successful run preserves both 200-row memberships and every updated
label. Compare owner-list call counts, CPU, and sampled allocation; virtual calls
per minute describe this scripted workload, not a production call-rate estimate.
