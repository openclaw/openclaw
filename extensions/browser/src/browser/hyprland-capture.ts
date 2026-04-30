import { spawn } from "node:child_process";

export function isHyprlandAvailable(): boolean {
  return Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);
}

function collectSpawnStdout(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    proc.on("error", reject);
  });
}

type HyprlandClientEntry = {
  pid: number;
  at: [number, number];
  size: [number, number];
};

export async function captureWithHyprland(params: { browserPid: number }): Promise<Buffer> {
  const raw = await collectSpawnStdout("hyprctl", ["clients", "-j"]);
  const clients = JSON.parse(raw.toString("utf8")) as HyprlandClientEntry[];
  const entry = clients.find((c) => c.pid === params.browserPid);
  if (!entry) {
    throw new Error(`No Hyprland window found for PID ${params.browserPid}`);
  }
  const [x, y] = entry.at;
  const [w, h] = entry.size;
  if (w <= 0 || h <= 0) {
    throw new Error(
      `Hyprland window for PID ${params.browserPid} has invalid dimensions ${w}x${h}`,
    );
  }
  const buf = await collectSpawnStdout("grim", ["-g", `${x},${y} ${w}x${h}`, "-"]);
  if (buf.byteLength === 0) {
    throw new Error("grim produced empty output");
  }
  return buf;
}
