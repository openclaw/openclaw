## Plugin-Suite Workflow

Use this section when perf work involves bundled plugins, plugin-inspector, SDK
barrels, package-boundary tests, or extension suites.

1. Map the suite shape first:
   - source tests: `pnpm test extensions/<id>` or `pnpm test:extensions:batch <id>`
   - package boundaries: `pnpm run test:extensions:package-boundary:canary` and
     `pnpm run test:extensions:package-boundary:compile`
   - all bundled source tests: `pnpm test:extensions`
   - plugin import memory: `pnpm test:extensions:memory -- --json .artifacts/test-perf/extensions-memory.json`
   - plugin-inspector/report work: keep report primitives in `plugin-inspector`;
     keep wrappers thin and collect peak RSS when the command supports it.
2. Start narrow, then widen:
   - one plugin changed: run that plugin's tests and plugin-inspector slice.
   - SDK/public barrel changed: add representative provider, channel, memory,
     and feature plugins.
   - loader/runtime mirror changed: add package-boundary checks and build/package
     proof as needed.
   - unknown shared plugin behavior: run `test:extensions:batch` groups before
     `pnpm test:extensions`.
3. Treat plugin-inspector failures as product signals:
   - JSON must parse.
   - warnings/errors must be classified, not hidden.
   - runtime capture should be quiet and config-tolerant.
   - command output should include wall time, exit code, and peak RSS when
     available.
4. Follow `$openclaw-testing` for host selection. Trusted source benchmarks
   can run locally with comparable machine/load conditions. Use `$crabbox` when
   clean packaging, Linux/platform behavior, isolation, or an explicit remote
   request is part of the proof; reuse and clean up only the owned lease.
5. If plugin performance is package-artifact sensitive, switch to
   `release-openclaw-plugin-testing` and Package Acceptance rather than
   trusting source-only timing.
