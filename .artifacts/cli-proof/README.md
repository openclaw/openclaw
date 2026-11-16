# Shipped path probe (temporary)

`node probe.mjs base|head` loads the built `dist/export-trajectory` chunk (BASE) and the
same chunk with only `writeSupportBundleDirectory` swapped for the staged sibling
implementation (HEAD), then injects one ENOSPC on the transcript `.jsonl` write.
