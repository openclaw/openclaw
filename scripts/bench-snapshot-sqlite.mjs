if (process.env.SNAPSHOT_STRESS_DEBUG === "1") {
  console.error("[snapshot-stress] loading runner");
}

const { runSnapshotStressCli } = await import("./bench-snapshot-sqlite.ts");

if (process.env.SNAPSHOT_STRESS_DEBUG === "1") {
  console.error("[snapshot-stress] starting runner");
}

await runSnapshotStressCli(process.argv.slice(2));
