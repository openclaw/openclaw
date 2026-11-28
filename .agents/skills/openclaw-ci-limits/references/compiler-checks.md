# Compiler checks

- Current extension-package-boundary checks request the 16-class in both the
  additional-check matrix and shared SDK producer; frozen targets retain the
  32-class. The existing two-CPU compiler reserve admits two children on the
  observed four-CPU 16-class allocation. Keep that resource guard authoritative.
  Compare equivalent workloads and cache states before claiming savings;
  historical 16/32-class runs also differed in compiler optimization. See
  `docs/ci/routing-costs.md` for sizing evidence. No jobs, registrations,
  permissions, compiler checks, or hosted eligibility are added.
  The package-boundary row has a 40-minute whole-job budget: three hosted
  four-CPU attempts hit the former 20-minute limit, with about 19 minutes in
  SDK preparation and 126 compiles before final validation/canary/cleanup.
  One completed both compile and canary but still exceeded the job deadline.
  Two hosted release validations then passed both checks (128 plugins) and
  were cancelled at the former 30-minute limit.
  Compiler concurrency, complete inventory, receipt guards, canary, and routing
  remain unchanged.
- The Plugin SDK API diff row also has a 30-minute whole-job budget. Two hosted
  runs spent 722 and 725 seconds rendering the base, then hit the former
  20-minute deadline during the candidate render. Keep both complete revision
  renders and the existing eight-CPU/24-GiB floor for two render workers;
  smaller hosts remain serial. Other additional-check groups retain 20 minutes.
