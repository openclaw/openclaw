process.stdout.write(
  JSON.stringify({
    version: process.versions.node ?? null,
    bunVersion: process.versions.bun ?? null,
    execPath: process.execPath ?? null,
  }),
);
