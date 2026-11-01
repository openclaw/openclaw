import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

const mode = process.env.OPENCLAW_MUSE_LIVE_AUTH;

async function login() {
  const env = { ...process.env };
  delete env.META_API_KEY;
  await new Promise((resolve, reject) => {
    const child = spawn("muse", ["login"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "" };
    let announced = false;
    let settled = false;
    /** @param {Error | undefined} error */
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        finish(
          new Error(
            "Muse device login timed out after 10 minutes. Run the live lane again and approve the device promptly.",
          ),
        );
      },
      10 * 60 * 1000,
    );
    const observe = (stream, chunk) => {
      output[stream] = (output[stream] + chunk.toString("utf8")).slice(-32_768);
      if (announced) {
        return;
      }
      // Muse 1.3 prints "Open this page to sign in: https://auth.meta.com/oauth/device/?code=XXXX-XXXX".
      const match = /(https:\/\/\S+[?&]code=([A-Z0-9]+(?:-[A-Z0-9]+)*))/.exec(
        stripVTControlCharacters(`${output.stdout}\n${output.stderr}`),
      );
      if (!match) {
        return;
      }
      announced = true;
      // The one intentional auth disclosure lets the operator approve this disposable container.
      console.log(`MUSE_DEVICE_CODE=${match[2]} MUSE_DEVICE_URL=${match[1]}`);
    };
    child.stdout.on("data", (chunk) => observe("stdout", chunk));
    child.stderr.on("data", (chunk) => observe("stderr", chunk));
    child.once("error", () =>
      finish(
        new Error("Could not start muse login. Check that the real Muse CLI is installed on PATH."),
      ),
    );
    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            "Muse device login failed. Run the live lane again and complete browser authentication.",
          ),
        );
      } else if (!announced) {
        finish(
          new Error(
            "Muse login did not expose a device code and verification URL; device authentication was not proven.",
          ),
        );
      } else {
        finish();
      }
    });
  });
}

try {
  if (mode === "api-key") {
    if (!process.env.META_API_KEY?.trim()) {
      throw new Error("OPENCLAW_MUSE_LIVE_AUTH=api-key requires META_API_KEY.");
    }
    console.log("Muse API-key authentication selected; browser login skipped.");
  } else if (mode === "device") {
    console.log("Waiting up to 10 minutes for Muse device authentication.");
    await login();
    console.log("Muse device authentication completed.");
  } else {
    throw new Error("Set OPENCLAW_MUSE_LIVE_AUTH to device or api-key.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
