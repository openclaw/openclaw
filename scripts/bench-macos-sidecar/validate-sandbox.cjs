const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
(async () => {
  const root = fs.realpathSync(process.env.RFC54_BENCH_ROOT);
  const repo = fs.realpathSync(process.env.OPENCLAW_BENCH_REPO);
  const allowed = net.createServer((socket) => socket.end()),
    blocked = net.createServer((socket) => socket.end());
  allowed.listen(0, "127.0.0.1");
  blocked.listen(0, "127.0.0.1");
  await Promise.all([once(allowed, "listening"), once(blocked, "listening")]);
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-D",
      `BENCH_ROOT=${root}`,
      "-D",
      `BENCH_ENDPOINT=localhost:${allowed.address().port}`,
      "-f",
      root + "/sandbox.sb",
      root + "/bin/sandbox-probe",
      String(allowed.address().port),
      String(blocked.address().port),
      path.join(repo, "README.md"),
    ],
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const [code] = await once(child, "exit");
  allowed.close();
  blocked.close();
  fs.writeFileSync(root + "/sandbox-proof.log", output);
  process.stdout.write(output);
  if (code !== 0) {
    throw new Error("Sandbox isolation validation failed");
  }
})().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exitCode = 1;
});
