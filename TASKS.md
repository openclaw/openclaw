# Tasks

- [x] Benchmark baseline load time <!-- id: 1 -->
    - [x] Run `time openclaw help`
    - [x] Run `time openclaw status`
    - [x] Create `docs/analysis/cli-bottlenecks/benchmarks.md`
- [x] Analyze import graph to find eager loading culprits <!-- id: 3 -->
- [x] Refactor command registry <!-- id: 7 -->
    - [x] Convert `src/cli/program/command-registry.ts` to use lazy imports
    - [x] Isolate `status` command dependencies
- [ ] Optimize build-time penalties <!-- id: 2 -->
- [ ] Streamline subcommand registration <!-- id: 3 -->
- [ ] Reduce global registry imports <!-- id: 4 -->
- [ ] Test and validate improvements <!-- id: 5 -->
- [ ] Iterate on instrumentation <!-- id: 6 -->
