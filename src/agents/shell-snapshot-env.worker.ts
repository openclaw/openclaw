import { captureShellSnapshotEnvironment } from "./shell-snapshot-env.js";

process.stdout.write(JSON.stringify(captureShellSnapshotEnvironment(process.env)));
