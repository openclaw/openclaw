// Publishes the base declaration partition that owns the typed runtime entries.
//
// The dist-dependent core-test type-check shard resolves the e2e's
// `../../dist/*.js` specifiers, so those .d.ts must exist before the checker
// runs. The canonical declaration writer stages the group privately and
// publishes only the partition it built, which is what keeps a prior full
// build's SDK and extension declarations in place.
//
// The publish reports no previous inventory: this partition always emits its own
// entries, and handing the publisher a wider list would delete every declared
// output it did not just write.
import { TSDOWN_UNIFIED_DTS_CONFIG_GROUPS } from "./lib/tsdown-config-groups.mts";
import { writeTsdownDeclarations } from "./lib/tsdown-declaration-writer.mts";

// The base declaration partition owns the typed runtime entries (index plus the
// e2e-typed runtime names in tsdown.config.ts); it is the first unified DTS group.
await writeTsdownDeclarations(
  [TSDOWN_UNIFIED_DTS_CONFIG_GROUPS[0]],
  "tsdown-typed-runtime",
  () => [],
  "scripts/write-typed-runtime-entry-dts.ts",
);
